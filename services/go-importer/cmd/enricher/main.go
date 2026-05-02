package main

import (
	"fmt"
	"go-importer/internal/pkg/db"
	"io"
	"net/netip"
	"path/filepath"
	"strings"

	"bufio"
	"errors"
	"flag"
	"log"
	"os"
	"time"

	"github.com/gofrs/uuid/v5"
	"github.com/tidwall/gjson"
)

var eve_file = flag.String("eve", "", "Eve file or glob to watch (e.g. /suricata/eve.json or /suricata/eve-*.json for split mode)")
var timescale = flag.String("timescale", "", "Timescale connection string (e. g. postgres://usr:pwd@host:5432/iris)")
var tag_flowbits = flag.Bool("flowbits", true, "Tag flows with their flowbits")
var rescan_period = flag.Int("t", 30, "rescan period (in seconds).")

// Emit sid:<N> tags per rule hit. Disable for long CTFs where the tag table
// grows unbounded. Defaults to true to match EMIT_SID_TAGS=1 in .env.example.
var emit_sid_tags = true

var g_db *db.Database

// errFlowNotFound is returned by handleEveLine when an alert references a
// flow tuple that hasn't been inserted into the DB yet. The assembler may
// still be buffering the flow under -flush-after; we hold the alert and retry
// on subsequent scan cycles instead of silently losing the tag.
var errFlowNotFound = errors.New("flow not found yet")

type deferredAlert struct {
	line  string
	until time.Time
}

var (
	deferred       []deferredAlert
	deferredMaxAge = 5 * time.Minute
	deferredMaxLen = 1000
)

func deferAlert(line string) {
	if len(deferred) >= deferredMaxLen {
		deferred = deferred[1:]
	}
	deferred = append(deferred, deferredAlert{
		line:  line,
		until: time.Now().Add(deferredMaxAge),
	})
}

func retryDeferred() {
	if len(deferred) == 0 {
		return
	}
	now := time.Now()
	keep := deferred[:0]
	dropped := 0
	for _, d := range deferred {
		if now.After(d.until) {
			dropped++
			continue
		}
		err := handleEveLine(d.line)
		if err == nil {
			continue // applied; handleEveLine already logs "Applied"
		}
		if errors.Is(err, errFlowNotFound) {
			keep = append(keep, d)
			continue
		}
		log.Printf("dropping deferred alert (parse error): %s", err)
	}
	deferred = keep
	if dropped > 0 {
		log.Printf("aged out %d deferred alert(s) with no matching flow after %s", dropped, deferredMaxAge)
	}
}

func main() {
	flag.Parse()
	if *eve_file == "" {
		log.Fatal("Usage: ./enricher -eve eve.json")
	}

	// If no timescale connection string was supplied, use env variable
	if *timescale == "" {
		*timescale = os.Getenv("TIMESCALE")
	}

	// EMIT_SID_TAGS: any of "0", "false", "no" disables per-sid tags.
	switch strings.ToLower(os.Getenv("EMIT_SID_TAGS")) {
	case "0", "false", "no":
		emit_sid_tags = false
	}

	log.Println("Connecting to Timescale:", *timescale, "...")
	g_db = db.NewDatabase(*timescale)

	watchEve(*eve_file)
}

// isGlob returns true if the path looks like a glob pattern. Used to keep
// the single-file all-in-one mode (`-eve /suricata/eve.json`) bit-identical
// to before, while a pattern like `/suricata/eve-*.json` activates the
// multi-file split-mode behaviour.
func isGlob(p string) bool {
	return strings.ContainsAny(p, "*?[")
}

// fileState is the per-file scan offset for the multi-file watcher.
type fileState struct {
	ratchet  int64
	prevSize int64
}

func watchEve(eve_pattern string) {
	states := map[string]*fileState{}

	// Resolve the pattern to a list of files. A bare path resolves to itself
	// (existing or not); a glob resolves to whatever currently matches.
	resolve := func() []string {
		if !isGlob(eve_pattern) {
			return []string{eve_pattern}
		}
		matches, err := filepath.Glob(eve_pattern)
		if err != nil {
			log.Println("Bad glob pattern:", eve_pattern, err)
			return nil
		}
		return matches
	}

	// Initial scan: read every match from the top so existing alerts (e.g.
	// from a previous run) are processed.
	log.Println("Parsing initial eve contents from", eve_pattern)
	for _, path := range resolve() {
		st := &fileState{}
		st.ratchet = updateEve(path, 0)
		if info, err := os.Stat(path); err == nil {
			st.prevSize = info.Size()
		}
		states[path] = st
	}
	if isGlob(eve_pattern) {
		log.Printf("Monitoring %d eve file(s) matching %s", len(states), eve_pattern)
	} else {
		log.Println("Monitoring eve file: ", eve_pattern)
	}

	for {
		time.Sleep(time.Duration(*rescan_period) * time.Second)

		// Retry alerts whose flow was not yet in the DB on a previous scan.
		retryDeferred()

		// Re-resolve the pattern so newly-added vulnboxes (whose shipper just
		// dropped a fresh eve-<host>.json) are picked up automatically.
		current := resolve()
		seen := map[string]bool{}
		for _, path := range current {
			seen[path] = true
			st, ok := states[path]
			if !ok {
				log.Println("New eve file appeared:", path)
				st = &fileState{}
				states[path] = st
			}

			info, err := os.Stat(path)
			if err != nil {
				continue
			}

			// Handle rotation / rsync-replacement: shrunk file => reset.
			if info.Size() < st.ratchet {
				log.Println("Eve file shrank (rotated/truncated?), resetting ratchet to 0:", path)
				st.ratchet = 0
				st.prevSize = 0
			}

			if info.Size() > st.prevSize {
				log.Printf("Eve file %s updated. New size: %d", path, info.Size())
				st.ratchet = updateEve(path, st.ratchet)
			}
			st.prevSize = info.Size()
		}
		// Forget vanished files so the map doesn't grow unbounded across a
		// long CTF where vulnboxes come and go.
		for path := range states {
			if !seen[path] {
				log.Println("Eve file gone, dropping state for:", path)
				delete(states, path)
			}
		}
	}
}

// The eve file was just written to, let's parse some logs!
func updateEve(eve_file string, ratchet int64) int64 {

	// Open a handle to the eve file
	eve_handle, err := os.Open(eve_file)
	if err != nil {
		log.Println("Failed to open the eve file")
		return ratchet
	}
	eve_handle.Seek(ratchet, 0)
	eve_reader := bufio.NewReader(eve_handle)
	defer eve_handle.Close()

	log.Println("Start scanning eve file at offset", ratchet)

	// iterate over each line in the file
	for {
		line, err := eve_reader.ReadString('\n')

		// Found EOF, this line is incomplete
		if err == io.EOF {
			break
		}

		// Something other then EOF, stop and log it
		if err != nil {
			log.Printf("Error reading eve at offset %d: %s\n", ratchet, err)
			break
		}

		err = handleEveLine(line)
		switch {
		case err == nil:
			// applied (or intentionally skipped: no actionable content)
		case errors.Is(err, errFlowNotFound):
			// Flow not yet in DB. Save the line for retry; advance the
			// ratchet so we don't re-read it from the file on next scan.
			deferAlert(line)
		default:
			// Genuine parse error. Skip - re-reading won't help.
			log.Printf("Error parsing eve at offset %d: %s\n", ratchet, err)
		}
		ratchet += int64(len(line))
	}

	// Roll the eve handle back to the last successfully applied rule, so it can continue there
	// next time this function is called.
	return ratchet
}

/*
	{
		"timestamp": "2022-05-17T19:39:57.283547+0000",
		"flow_id": 1905964640824789,
		"in_iface": "eth0",
		"event_type": "alert",
		"src_ip": "131.155.9.104",
		"src_port": 53604,
		"dest_ip": "165.232.89.44",
		"dest_port": 1337,
		"protobufs": "TCP",
		"pkt_src": "stream (flow timeout)",
		"alert": {
			"action": "allowed",
			"gid": 1,
			"signature_id": 1338,
			"rev": 1,
			"signature": "Detected too many A's (smart)",
			"category": "",
			"severity": 3
		},
		"app_proto": "failed",
		"flow": {
			"pkts_toserver": 6,
			"pkts_toclient": 6,
			"bytes_toserver": 437,
			"bytes_toclient": 477,
			"start": "2022-05-17T19:37:02.978389+0000"
		}
	}
*/

func handleEveLine(json string) error {
	if !gjson.Valid(json) {
		return errors.New("Invalid json in eve line")
	}

	// TODO; error check this
	src_port := gjson.Get(json, "src_port")
	src_ip := gjson.Get(json, "src_ip")
	dst_port := gjson.Get(json, "dest_port")
	dst_ip := gjson.Get(json, "dest_ip")
	start_time := gjson.Get(json, "flow.start")

	sig_msg := gjson.Get(json, "alert.signature")
	sig_id := gjson.Get(json, "alert.signature_id")
	sig_action := gjson.Get(json, "alert.action")
	sig_tags := gjson.Get(json, "alert.metadata.tag")
	flowbits := gjson.Get(json, "metadata.flowbits")

	// canonicalize the IP address notation to make sure it matches what the assembler entered
	// into the database.
	// TODO; just assuming these are all valid for now. Should be fine, since this is coming from
	// suricata and is not _really_ user controlled. Might panic in some obscure case though.
	ip_src, _ := netip.ParseAddr(src_ip.String())
	ip_dst, _ := netip.ParseAddr(dst_ip.String())

	// TODO; Double check this, might be broken for non-UTC?
	start_time_obj, _ := time.Parse("2006-01-02T15:04:05.999999999-0700", start_time.String())

	// If no action was taken, there's no need for us to do anything with this line.
	if !(sig_action.Exists() || (flowbits.Exists() && *tag_flowbits)) {
		return nil
	}

	flow_id, _ := g_db.SuricataIdFindFlow(db.SuricataId {
		Src_port: int(src_port.Int()),
		Src_ip:   ip_src,
		Dst_port: int(dst_port.Int()),
		Dst_ip:   ip_dst,
		Time:     start_time_obj,
	})

	if flow_id == uuid.Nil {
		flow_id, _ = g_db.SuricataIdFindFlow(db.SuricataId {
			Dst_port: int(src_port.Int()),
			Dst_ip:   ip_src,
			Src_port: int(dst_port.Int()),
			Src_ip:   ip_dst,
			Time:     start_time_obj,
		})
	}

	// Flow not found - likely a race with the assembler's flush. Surface a
	// distinct error so the scan loop can hold the alert and retry later.
	if flow_id == uuid.Nil {
		return errFlowNotFound
	}

	tags := []string{}
	firstMetadataTag := ""
	if sig_tags.Exists() {
		sig_tags.ForEach(func(key, value gjson.Result) bool {
			raw := value.String()
			tags = append(tags, raw)
			// Also emit a namespaced `rule:<tag>` alias so operators can
			// filter strictly on rule matches without colliding with
			// assembler-generated tags. Only the first metadata tag gets
			// the namespaced alias to avoid tag-table explosion.
			if firstMetadataTag == "" && raw != "" {
				firstMetadataTag = raw
				tags = append(tags, "rule:"+strings.ToLower(strings.ReplaceAll(raw, " ", "_")))
			}
			return true
		})
	}

	if sig_action.Exists() {
		sig := db.Signature{
			Id:      int32(sig_id.Int()),
			Message: sig_msg.String(),
			Action:  sig_action.String(),
			Tag:     firstMetadataTag,
		}

		tags = append(tags, "suricata")
		if sig.Action == "blocked" {
			tags = append(tags, "blocked")
		}
		if emit_sid_tags && sig.Id > 0 {
			tags = append(tags, fmt.Sprintf("sid:%d", sig.Id))
		}

		g_db.FlowAddSignatures(flow_id, []db.Signature{sig})
	}

	if flowbits.Exists() && *tag_flowbits {
		flowbits.ForEach(func(key, value gjson.Result) bool {
			tags = append(tags, value.String())
			return true // keep iterating
		})
	}

	g_db.FlowAddTags(flow_id, tags)

	if len(tags) > 0 {
		log.Println("Applied", tags, "tags to flow", flow_id)
	}

	return nil
}
