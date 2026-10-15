# Reuse the already verified official image to avoid the host's blocked Docker Hub.
FROM docker.gitea.com/gitea@sha256:b1a90409ae9afcd5a5725404c3639da7245248848b99e35332968891290b953e
USER root
RUN sed -i 's@https://dl-cdn.alpinelinux.org/alpine@https://mirrors.aliyun.com/alpine@g' /etc/apk/repositories
RUN apk add --no-cache nodejs npm openjdk17-jdk maven openssh-server \
    openssh-client python3 make g++ util-linux bubblewrap ripgrep \
    && adduser -D -u 1001 -G git -h /home/runner -s /bin/bash runner \
    && passwd -d runner \
    && mkdir -p /opt/dsh-helper /etc/argon /run/sshd \
    && chmod 755 /home/runner
RUN npm --prefix /opt/dsh-helper --registry=https://registry.npmmirror.com install --omit=dev \
    @deepseek-ai/dsh-ssh@0.2.0-rc.2 \
    @deepseek-ai/dsh-fs-local@0.2.0-rc.2 \
    @deepseek-ai/dsh-fs-sandbox@0.2.0-rc.2 \
    @deepseek-ai/dsh-subprocess-local@0.2.0-rc.2 \
    @deepseek-ai/dsh-sandbox-local@0.2.0-rc.2
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /opt/argon-entrypoint.sh
COPY m2-seed /opt/m2-seed
RUN chmod 755 /opt/argon-entrypoint.sh && chmod -R a+rX /opt/dsh-helper /opt/m2-seed
ENTRYPOINT ["/opt/argon-entrypoint.sh"]
