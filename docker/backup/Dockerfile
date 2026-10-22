FROM postgres:17-alpine
RUN apk add --no-cache rclone age tzdata
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod 755 /usr/local/bin/backup.sh && mkdir -p /backup/nas && chown postgres:postgres /backup/nas
USER postgres
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["loop"]
