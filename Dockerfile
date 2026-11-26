FROM python:3.10-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN python --version && node --version && npm --version

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8710

ENV PYTHONUNBUFFERED=1
ENV NODE_ENV=production
ENV OPS_HOST=0.0.0.0
ENV OPS_PORT=8710

CMD ["python", "-X", "utf8", "-m", "ops", "serve"]

