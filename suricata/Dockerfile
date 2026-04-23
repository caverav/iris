FROM jasonish/suricata:7.0

RUN apk add --no-cache bash iptables ip6tables py3-pip \
    && pip3 install --no-cache-dir --break-system-packages suricata-update || true

COPY entrypoint.sh /usr/local/bin/iris-suricata-entrypoint.sh
COPY rules /seed/rules
COPY etc /seed/etc

RUN chmod +x /usr/local/bin/iris-suricata-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/iris-suricata-entrypoint.sh"]
