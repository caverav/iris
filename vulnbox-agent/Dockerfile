FROM alpine:3.19

# rsync/ssh for the shipper; curl/jq for the rules-puller's HTTP fetch;
# socat for talking JSON to Suricata's unix-command socket.
RUN apk add --no-cache bash rsync openssh-client curl jq socat coreutils

COPY ship.sh        /usr/local/bin/ship.sh
COPY pull-rules.sh  /usr/local/bin/pull-rules.sh
COPY entrypoint.sh  /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/ship.sh /usr/local/bin/pull-rules.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
