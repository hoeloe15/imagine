#!/bin/sh
# Container Apps names the listening port `PORT`; the server reads
# IMAGINE_HTTP_PORT (ADR 0016). Bridge the two here rather than teaching the
# transport a second port variable, so the local and the container contract stay
# one each. Precedence: IMAGINE_HTTP_PORT, then PORT, then 8080.
set -eu

IMAGINE_HTTP_PORT="${IMAGINE_HTTP_PORT:-${PORT:-8080}}"
export IMAGINE_HTTP_PORT

exec "$@"
