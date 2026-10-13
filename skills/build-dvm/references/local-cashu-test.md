# Local Cashu paid test

Use this after the builder approves the DVM price and a separate cap for one test payment. A `$0.01` price is fixed in dollars; the Cashu sats vary with the server's live quote. Derive the debit from the 402 and signed receipt. Never assume the server reads the caller's BTC-rate cache.

The Docker-free default is the canonical hosted FakeWallet mint at `https://dvmkit-testmint.fly.dev`; override it only with another approved `CASHU_MINT_URL`. Set `CASHU_LOCAL_MINT=1` to opt into the owned Nutshell container fallback. Docker is needed only for that explicit fallback; `dvmctl dev` itself is Docker-free and needs no Postgres.

Set the values from the approved brief. Object inputs use `--data`; keep stdin closed so the caller cannot wait on the terminal.

```bash
set -euo pipefail
DVM_CAPABILITY="uppercase"
DVM_INPUT='{"text":"your approved example"}'
DVM_PAYMENT_CAP='$0.02'

test_root="$(mktemp -d "${TMPDIR:-/tmp}/dvmkit-cashu-paid.XXXXXX")"
export DVM_CONFIG_DIR="$test_root/caller"
mkdir -p "$DVM_CONFIG_DIR"
mint_id=""
dvm_pid=""
cleanup() {
  status=$?
  trap - EXIT INT TERM
  [ -z "$dvm_pid" ] || kill "$dvm_pid" 2>/dev/null || true
  [ -z "$mint_id" ] || docker rm -f "$mint_id" >/dev/null 2>&1 || true
  if [ "$status" -eq 0 ]; then
    rm -rf "$test_root"
  else
    printf "Test failed; recovery state retained at %s\n" "$test_root" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [ "${CASHU_LOCAL_MINT:-0}" = "1" ]; then
  mint_name="dvmkit-cashu-mint-$$"
  docker run --rm -d --name "$mint_name" -p 127.0.0.1::3338 \
    -e MINT_LISTEN_HOST=0.0.0.0 -e MINT_LISTEN_PORT=3338 \
    -e MINT_BACKEND_BOLT11_SAT=FakeWallet \
    -e MINT_PRIVATE_KEY=test-key-do-not-use-in-production \
    cashubtc/nutshell:0.19.2 poetry run mint >/dev/null
  mint_id="$(docker container inspect --format '{{.Id}}' "$mint_name")"
  cashu_mint_url="http://127.0.0.1:$(docker port "$mint_id" 3338/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
else
  cashu_mint_url="${CASHU_MINT_URL:-https://dvmkit-testmint.fly.dev}"
fi
for _ in $(seq 1 30); do
  node -e 'fetch(process.argv[1]+"/v1/info",{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)throw Error(`HTTP ${r.status}`)}).catch(()=>process.exit(1))' "${cashu_mint_url%/}" && break
  sleep 1
done
node -e 'fetch(process.argv[1]+"/v1/info",{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)throw Error(`HTTP ${r.status}`)}).catch(e=>{console.error(e.message);process.exit(1)})' "${cashu_mint_url%/}"

dvmctl validate
dvmctl doctor
dvm_port="$(node -e 'require("node:net").createServer().listen(0,"127.0.0.1",function(){console.log(this.address().port);this.close()})')"
DVMKIT_CASHU_MINTS="$cashu_mint_url" dvmctl dev handler.ts --port "$dvm_port" >"$test_root/dvm.log" 2>&1 &
dvm_pid=$!
dvm_endpoint="http://127.0.0.1:$dvm_port"
for _ in $(seq 1 30); do
  node -e 'fetch(process.argv[1]+"/v1/info",{signal:AbortSignal.timeout(2000)}).then(async r=>{if(!r.ok)throw Error(`HTTP ${r.status}`);require("node:fs").writeFileSync(process.argv[2],await r.text())}).catch(()=>process.exit(1))' "$dvm_endpoint" "$test_root/info.json" && break
  sleep 1
done
node -e 'const i=require(process.argv[1]);if(!i.payment?.methods?.includes("cashu"))throw Error("cashu is not advertised")' "$test_root/info.json"

node --input-type=module - "$dvm_endpoint" "$DVM_CAPABILITY" "$DVM_INPUT" "$test_root/unpaid.json" <<'NODE'
import { writeFileSync } from "node:fs";
const [endpoint, capability, input, output] = process.argv.slice(2);
const response = await fetch(`${endpoint}/v1/job`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ capability, data: JSON.parse(input) }),
  signal: AbortSignal.timeout(5000),
});
const body = await response.json();
if (response.status !== 402 || body.error !== "payment_required" || !Number.isSafeInteger(body.required_msats) || body.required_msats <= 0 || body.required_msats % 1000 !== 0) {
  throw new Error(`expected a valid Cashu 402, got ${response.status} ${JSON.stringify(body)}`);
}
writeFileSync(output, JSON.stringify(body));
NODE

npm install --ignore-scripts --prefix "$test_root/tools" @dvmkit/dvm-cli@0.7.0
export PATH="$test_root/tools/node_modules/.bin:$PATH"
dvm init
dvm wallet init
dvm wallet mint-add "$cashu_mint_url"
dvm wallet fund '$1' --mint "$cashu_mint_url" --test-skip-lightning
dvm wallet show >"$test_root/before.json"
dvm request --endpoint "$dvm_endpoint" --data "$DVM_INPUT" --rail cashu --mint "$cashu_mint_url" \
  --budget "$DVM_PAYMENT_CAP" --auto-pay-below "$DVM_PAYMENT_CAP" \
  --max-increment "$DVM_PAYMENT_CAP" --max-payments 1 </dev/null >"$test_root/paid.json"
dvm wallet show >"$test_root/after.json"
job_id="$(node -p 'require(process.argv[1]).jobId' "$test_root/paid.json")"
result_dir="$PWD/.dvmkit-test-results/$job_id"
mkdir -p -m 700 "$result_dir"
cp "$test_root/unpaid.json" "$test_root/before.json" "$test_root/after.json" "$test_root/paid.json" "$result_dir/"
dvm messages "$job_id" --no-stream >/dev/null
TMPDIR="$result_dir" dvm messages "$job_id" --no-stream --human | tee "$result_dir/artifacts.txt"
retained_config="$result_dir/caller"
node - "$DVM_CONFIG_DIR" "$retained_config" "$result_dir/messages.json" "$job_id" <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [source, destination, resultPath, jobId] = process.argv.slice(2);
const job = JSON.parse(readFileSync(join(source, "jobs.json"), "utf8")).find(item => item.id === jobId);
if (!job) throw Error(`caller state did not retain ${jobId}`);
const receipts = readFileSync(join(source, "receipts.jsonl"), "utf8").trim().split("\n").filter(Boolean).filter(line => JSON.parse(line).receipt?.job_id === jobId);
if (receipts.length !== 1) throw Error(`expected one receipt for ${jobId}, found ${receipts.length}`);
const messages = readFileSync(join(source, "messages", `${jobId}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const retainedMessages = messages.filter(message => ["text", "artifact", "complete", "cancel"].includes(message.type));
if (!retainedMessages.some(message => message.type === "complete" || message.type === "cancel")) throw Error("caller state did not retain a terminal message");
const retainedJob = { id: job.id, endpoint: job.endpoint, status: job.status, submittedAt: job.submittedAt, completedAt: job.completedAt, completion: job.completion, paymentsHonoured: job.paymentsHonoured, policy: job.policy };
mkdirSync(join(destination, "messages"), { recursive: true, mode: 0o700 });
writeFileSync(join(destination, "jobs.json"), `${JSON.stringify([retainedJob])}\n`, { mode: 0o600 });
writeFileSync(join(destination, "receipts.jsonl"), `${receipts[0]}\n`, { mode: 0o600 });
writeFileSync(join(destination, "messages", `${jobId}.jsonl`), `${retainedMessages.map(message => JSON.stringify(message)).join("\n")}\n`, { mode: 0o600 });
writeFileSync(resultPath, `${JSON.stringify({ jobId, messages: retainedMessages })}\n`, { mode: 0o600 });
NODE
DVM_CONFIG_DIR="$retained_config" dvm receipts verify "$job_id" >"$result_dir/verified.json"
node - "$result_dir/unpaid.json" "$result_dir/before.json" "$result_dir/after.json" "$result_dir/paid.json" "$result_dir/messages.json" "$result_dir/verified.json" <<'NODE'
const [challengePath, beforePath, afterPath, paidPath, messagesPath, verifiedPath] = process.argv.slice(2);
const challenge=require(challengePath), before=require(beforePath), after=require(afterPath), paid=require(paidPath), messages=require(messagesPath), verified=require(verifiedPath);
const validReceiptStatuses = new Set(["verified", "verified_unattested"]);
const expectedSats=challenge.required_msats/1000;
if (before.total_sats-after.total_sats !== expectedSats) throw Error(`Cashu debit was ${before.total_sats-after.total_sats}, quote was ${expectedSats} sats`);
if (!paid.jobId || paid.next_action !== null || !validReceiptStatuses.has(paid.receipt_verified)) throw Error("paid result is not terminal with a valid receipt signature");
if (paid.receipt?.outcome !== "completed" || paid.receipt?.paid?.rail !== "cashu" || paid.receipt.paid.msats !== challenge.required_msats) throw Error("receipt is not bound to the 402 quote");
if (!messages.messages?.some(message => message.type === "complete")) throw Error("paid messages did not complete");
if ((paid.has_artifacts || paid.artifact_count > 0) && !messages.messages?.some(message => message.type === "artifact")) throw Error("paid result advertised an artifact that was not retrieved");
if (verified.job_id !== paid.jobId || !validReceiptStatuses.has(verified.receipt_verified) || verified.receipt_checks?.result_hash !== "ok") throw Error("stored receipt and paid result hash did not verify");
NODE
cat "$result_dir/paid.json"
printf '\nPaid result and artifact evidence retained in %s\n' "$result_dir"
```

The observed hosted-mint acceptance for a `$0.01` call quoted `12000` msats and debited `12` test sats. That is evidence from that rate snapshot, not a constant for future runs.

Stop on any cap refusal and ask for a new explicit cap. Do not raise flags automatically. A failed mint probe names the exact mint that must recover or be corrected.
