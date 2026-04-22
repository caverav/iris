FROM alpine:3.19

RUN apk add --no-cache bash rsync openssh-client

COPY ship.sh /usr/local/bin/ship.sh
RUN chmod +x /usr/local/bin/ship.sh

ENTRYPOINT ["/usr/local/bin/ship.sh"]
