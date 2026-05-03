FROM alpine:3.19

# rsync + ssh for the pull, jq for vulnbox-list parsing.
RUN apk add --no-cache bash rsync openssh-client jq

COPY fetch.sh /usr/local/bin/fetch.sh
RUN chmod +x /usr/local/bin/fetch.sh

ENTRYPOINT ["/usr/local/bin/fetch.sh"]
