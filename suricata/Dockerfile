FROM jasonish/suricata:7.0

# Base is AlmaLinux 9, not Alpine. Install both iptables backends so the
# init script can pick whichever the host kernel is using (nft for modern
# distros, legacy for older ones); see iptables-init.sh for the detection.
RUN dnf install -y --setopt=install_weak_deps=False \
        iptables-nft iptables-legacy python3-pip python3-setuptools \
    && dnf clean all \
    && pip3 install --no-cache-dir suricata-update

COPY entrypoint.sh /usr/local/bin/iris-suricata-entrypoint.sh
COPY rules /seed/rules
COPY etc /seed/etc

RUN chmod +x /usr/local/bin/iris-suricata-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/iris-suricata-entrypoint.sh"]
