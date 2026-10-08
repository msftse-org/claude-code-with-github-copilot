FROM node:24.18.1-bookworm-slim AS node
FROM python:3.14.6-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN groupadd --gid 10001 ccgc && useradd --uid 10001 --gid ccgc --create-home ccgc \
    && python -m venv /opt/venv
WORKDIR /app
COPY server/pyproject.toml /app/server/pyproject.toml
RUN /opt/venv/bin/python -c 'import subprocess,tomllib; subprocess.check_call(["/opt/venv/bin/pip","install","--no-cache-dir",*tomllib.load(open("server/pyproject.toml","rb"))["project"]["dependencies"]])'
COPY package.json /app/package.json
COPY src /app/src
COPY server/bootstrap.py /app/server/bootstrap.py
RUN install -d -m 0700 -o ccgc -g ccgc /state
ENV CCGC_STATE_DIR=/state CCGC_PYTHON=/opt/venv/bin/python \
    DO_NOT_TRACK=True LITELLM_LOCAL_MODEL_COST_MAP=True
USER ccgc
ENTRYPOINT ["/opt/venv/bin/python", "/app/server/bootstrap.py"]
CMD ["serve"]
