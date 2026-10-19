FROM python:3.12-slim
WORKDIR /app
# git: repo-discovery scanning. nodejs + chromium: the authored-UI-test runner drives
# Chromium over the DevTools Protocol — without these, every test run fails at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client ca-certificates nodejs chromium \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY runner ./runner
RUN useradd -r -u 10001 -m -d /home/app app \
    && mkdir -p /app/uploads \
    && chown -R app:app /app/uploads /home/app
ENV CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=1 \
    HOME=/home/app
USER app
EXPOSE 8000
CMD ["uvicorn","app.main:app","--host","0.0.0.0","--port","8000"]
