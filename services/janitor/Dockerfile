FROM alpine:3.19

# psql for the timescale retention policy, find/du for pcap pruning,
# bash because the script uses [[ and friends.
RUN apk add --no-cache bash coreutils findutils postgresql-client

COPY janitor.sh /usr/local/bin/janitor.sh
RUN chmod +x /usr/local/bin/janitor.sh

ENTRYPOINT ["/usr/local/bin/janitor.sh"]
