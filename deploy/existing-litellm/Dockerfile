ARG LITELLM_IMAGE=ghcr.io/berriai/litellm:main-latest

FROM python:3.13.11-slim@sha256:2b9c9803c6a287cafa0a8c917211dddd23dcd2016f049690ee5219f5d3f1636e AS ccgc-wheels

RUN mkdir /wheels \
    && pip download --index-url https://packagefeedproxy.microsoft.io/pypi/simple/ \
      --only-binary=:all: --dest /wheels \
      "asyncpg>=0.30.0,<1" \
      "azure-identity>=1.25.1,<2" \
      "azure-keyvault-secrets>=4.10.0,<5" \
      "PyJWT[crypto]>=2.10.1,<3"

FROM ${LITELLM_IMAGE}

COPY --from=ccgc-wheels /wheels /tmp/ccgc-wheels

RUN /app/.venv/bin/python -m ensurepip \
    && /app/.venv/bin/python -m pip install --no-cache-dir --no-index --find-links=/tmp/ccgc-wheels \
      "asyncpg>=0.30.0,<1" \
      "azure-identity>=1.25.1,<2" \
      "azure-keyvault-secrets>=4.10.0,<5" \
      "PyJWT[crypto]>=2.10.1,<3" \
    && rm -rf /tmp/ccgc-wheels

COPY server/ccgc_litellm_auth.py /app/ccgc_litellm_auth.py
