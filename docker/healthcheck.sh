#!/bin/sh
set -eu
node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.APP_BASE_PATH||'').replace(/\/$/,'')+'/health/ready',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
if [ "${MAIL_ENABLED:-false}" = true ]; then
    /usr/local/bin/mail-healthcheck
fi
