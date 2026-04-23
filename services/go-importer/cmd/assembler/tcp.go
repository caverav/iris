// Copyright 2012 Google, Inc. All rights reserved.
//
// Use of this source code is governed by a BSD-style license
// that can be found in the LICENSE file in the root of the source
// tree.

// The pcapdump binary implements a tcpdump-like command line tool with gopacket
// using pcap as a backend data collection mechanism.
package main

import (
	"go-importer/internal/pkg/db"
	"log"
	"net/netip"

	"sync"

	"github.com/gopacket/gopacket"
	"github.com/gopacket/gopacket/layers"
	"github.com/gopacket/gopacket/reassembly"
)

var allowmissinginit = true
var verbose = false
var debug = false
var quiet = true

/*
 * The TCP factory: returns a new Stream
 */
type TcpStreamFactory struct {
	reassemblyCallback func(db.FlowEntry)
}

func (factory *TcpStreamFactory) New(net, transport gopacket.Flow, tcp *layers.TCP, ac reassembly.AssemblerContext) reassembly.Stream {
	source := ac.GetCaptureInfo().AncillaryData[0].(string);
	fsmOptions := reassembly.TCPSimpleFSMOptions{
		SupportMissingEstablishment: *nonstrict,
	}
	stream := &TcpStream{
		net:                net,
		transport:          transport,
		tcpstate:           reassembly.NewTCPSimpleFSM(fsmOptions),
		optchecker:         reassembly.NewTCPOptionCheck(),
		source:             source,
		FlowItems:          []db.FlowItem{},
		src_port:           tcp.SrcPort,
		dst_port:           tcp.DstPort,
		reassemblyCallback: factory.reassemblyCallback,
	}
	return stream
}

/*
 * The assembler context
 */
type Context struct {
	CaptureInfo gopacket.CaptureInfo
}

func (c *Context) GetCaptureInfo() gopacket.CaptureInfo {
	return c.CaptureInfo
}

/*
 * TCP stream
 */

/* It's a connection (bidirectional) */
type TcpStream struct {
	tcpstate       *reassembly.TCPSimpleFSM
	fsmerr         bool
	optchecker     reassembly.TCPOptionCheck
	net, transport gopacket.Flow
	sync.Mutex
	// RDJ; These field are added to make mongo convertion easier
	source             string
	reassemblyCallback func(db.FlowEntry)
	FlowItems          []db.FlowItem
	src_port           layers.TCPPort
	dst_port           layers.TCPPort
	total_size         int
	num_packets        int
	// Set the first time we have to truncate bytes to stay under the per-
	// stream cap. Used to emit exactly one WARN per flow instead of spamming
	// the log for every segment past the threshold.
	truncated          bool
}

func (t *TcpStream) Accept(tcp *layers.TCP, ci gopacket.CaptureInfo, dir reassembly.TCPFlowDirection, nextSeq reassembly.Sequence, start *bool, ac reassembly.AssemblerContext) bool {
	// FSM
	if !t.tcpstate.CheckState(tcp, dir) {
		if !t.fsmerr {
			t.fsmerr = true
		}
		if !*nonstrict {
			return false
		}
	}

	return true
}

// ReassembledSG is called zero or more times.
// ScatterGather is reused after each Reassembled call,
// so it's important to copy anything you need out of it,
// especially bytes (or use KeepFrom())
func (t *TcpStream) ReassembledSG(sg reassembly.ScatterGather, ac reassembly.AssemblerContext) {
	dir, _, _, _ := sg.Info()
	length, _ := sg.Lengths()
	capInfo := ac.GetCaptureInfo()
	timestamp := capInfo.Timestamp
	t.num_packets += 1

	// Don't add empty streams to the DB
	if length == 0 {
		return
	}

	data := sg.Fetch(length)
	orig := length
	origData := data

	// Stay under the per-flow cap (see `-max-flow-item-size`). We have to
	// compute the budget *before* mutating total_size so the accumulator
	// reflects what we actually keep, not what arrived on the wire.
	cap_bytes := *maxFlowItemSize * 1024 * 1024
	bytes_available := cap_bytes - t.total_size
	if bytes_available < 0 {
		bytes_available = 0
	}
	if length > bytes_available {
		length = bytes_available
	}
	t.total_size += length
	data = data[:length]

	// Flag recovery past the cap.
	// If we're dropping bytes, scan the discarded tail for flag matches and
	// splice just the matches back onto `data`. The surrounding payload is
	// still gone, but the flag tag + value are preserved so the UI, the
	// validator, and the Flags_Out counter all keep working even on flows
	// larger than -max-flow-item-size. Cap may be exceeded by at most a few
	// flag-length bytes per match; we accept that trade-off to avoid
	// silently losing points.
	if length < orig && flagRegex != nil {
		for _, m := range flagRegex.FindAll(origData[length:], -1) {
			data = append(data, '\n')
			data = append(data, m...)
		}
	}

	if length < orig && !t.truncated {
		t.truncated = true
		log.Printf("WARN: flow %s:%d -> %s:%d exceeded -max-flow-item-size (%d MiB); truncating (first dropped %d bytes on this segment). Flag regex matches from the dropped tail are recovered onto the stream; raise the cap with -max-flow-item-size if you need the full payload.",
			t.net.Src(), t.src_port, t.net.Dst(), t.dst_port, *maxFlowItemSize, orig-length)
	}

	var from string
	if dir == reassembly.TCPDirClientToServer {
		from = "c"
	} else {
		from = "s"
	}

	// consolidate subsequent elements from the same origin
	l := len(t.FlowItems)
	if l > 0 {
		if t.FlowItems[l-1].From == from {
			t.FlowItems[l-1].Data = append(t.FlowItems[l-1].Data, data...)
			// All done, no need to add a new item
			return
		}
	}

	// Add a FlowItem based on the data we just reassembled
	t.FlowItems = append(t.FlowItems, db.FlowItem{
		Kind: "raw",
		From: from,
		Data: data,
		Time: timestamp,
	})
}

// ReassemblyComplete is called when assembly decides there is
// no more data for this Stream, either because a FIN or RST packet
// was seen, or because the stream has timed out without any new
// packet data (due to a call to FlushCloseOlderThan).
// It should return true if the connection should be removed from the pool
// It can return false if it want to see subsequent packets with Accept(), e.g. to
// see FIN-ACK, for deeper state-machine analysis.
func (t *TcpStream) ReassemblyComplete(ac reassembly.AssemblerContext) bool {
	if len(t.FlowItems) == 0 {
		// No point in inserting this element, it has no data and even if we wanted to,
		// we can't timestamp it so the front-end can't display it either
		return false
	}

	src, dst := t.net.Endpoints()
	ip_src, _ := netip.ParseAddr(src.String())
	ip_dst, _ := netip.ParseAddr(dst.String())

	timeStart := t.FlowItems[0].Time
	timeEnd := t.FlowItems[0].Time
	for _, item := range t.FlowItems {
		if timeEnd.Before(item.Time) {
			timeEnd = item.Time
		}
	}

	entry := db.FlowEntry{
		Src_port:    uint16(t.src_port),
		Dst_port:    uint16(t.dst_port),
		Src_ip:      ip_src,
		Dst_ip:      ip_dst,
		Time:        timeStart,
		Duration:    timeEnd.Sub(timeStart),
		Num_packets: t.num_packets,
		Parent_id:   nil,
		Child_id:    nil,
		Tags:        []string { "tcp" },
		Filename:    t.source,
		Flow:        t.FlowItems,
		Size:        t.total_size,
		Flags:       make([]string, 0),
		Flagids:     make([]string, 0),
	}

	t.reassemblyCallback(entry)

	// do not remove the connection to allow last ACK
	return false
}
