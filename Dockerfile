FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HERITAGE_HOST=0.0.0.0 \
    HERITAGE_PORT=8080 \
    HERITAGE_DB_PATH=/tmp/heritage.db

WORKDIR /app

COPY app.zip /tmp/app.zip

RUN python -m zipfile -e /tmp/app.zip /app \
    && rm -f /tmp/app.zip \
    && server_file="$(find /app -name server.py -print -quit)" \
    && test -n "$server_file" \
    && printf '#!/bin/sh\nexec python "%s"\n' "$server_file" > /app/start.sh \
    && chmod 0755 /app/start.sh \
    && useradd --system --uid 10001 --create-home heritage \
    && chown -R heritage:heritage /app

USER heritage

EXPOSE 8080

CMD ["/app/start.sh"]
