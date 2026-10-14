# Local x402 paid test on Base Sepolia

Use this only after the builder approves a test-payment cap and supplies a Base Sepolia wallet containing at least the approved amount in test USDC. Base Sepolia has no unattended public faucet. Never substitute Base mainnet or a production key.

```bash
set -euo pipefail
DVM_CAPABILITY="uppercase"
DVM_INPUT='{"text":"your approved example"}'
DVM_PAYMENT_CAP='$0.02'
X402_TESTNET_KEY_FILE="/absolute/path/to/base-sepolia-test-key"

test_root="$(mktemp -d "${TMPDIR:-/tmp}/dvmkit-x402-paid.XXXXXX")"
export DVM_CONFIG_DIR="$test_root/caller"
mkdir -p "$DVM_CONFIG_DIR"
dvm_pid=""
cleanup() {
  status=$?
  trap - EXIT INT TERM
  [ -z "$dvm_pid" ] || kill "$dvm_pid" 2>/dev/null || true
  if [ "$status" -eq 0 ]; then
    rm -rf "$test_root"
  else
    printf "Test failed; recovery state retained at %s\n" "$test_root" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

test -f "$X402_TESTNET_KEY_FILE"
node --input-type=module <<'NODE'
const rpc = await fetch("https://sepolia.base.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_chainId",params:[]}), signal: AbortSignal.timeout(5000) });
const body = await rpc.json();
if (!rpc.ok || body.result !== "0x14a34") throw new Error(`Base Sepolia RPC mismatch: ${rpc.status} ${JSON.stringify(body)}`);
const facilitator = await fetch("https://x402.org/facilitator/supported", { signal: AbortSignal.timeout(5000) });
if (!facilitator.ok) throw new Error(`x402 facilitator HTTP ${facilitator.status}`);
NODE

recipient="0x$(node -e 'process.stdout.write(require("node:crypto").randomBytes(20).toString("hex"))')"
dvmctl validate
dvmctl doctor
dvm_port="$(node -e 'require("node:net").createServer().listen(0,"127.0.0.1",function(){console.log(this.address().port);this.close()})')"
env DVMKIT_X402_PAY_TO="$recipient" DVMKIT_X402_NETWORK="eip155:84532" \
  DVMKIT_X402_FACILITATOR="https://x402.org/facilitator" \
  dvmctl dev handler.ts --port "$dvm_port" >"$test_root/dvm.log" 2>&1 &
dvm_pid=$!
dvm_endpoint="http://127.0.0.1:$dvm_port"
for _ in $(seq 1 30); do
  node -e 'fetch(process.argv[1]+"/v1/info",{signal:AbortSignal.timeout(2000)}).then(async r=>{if(!r.ok)throw Error(`HTTP ${r.status}`);require("node:fs").writeFileSync(process.argv[2],await r.text())}).catch(()=>process.exit(1))' "$dvm_endpoint" "$test_root/info.json" && break
  sleep 1
done
node -e 'const i=require(process.argv[1]);if(i.x402?.network!=="eip155:84532")throw Error("Base Sepolia is not advertised")' "$test_root/info.json"

node --input-type=module - "$dvm_endpoint" "$DVM_CAPABILITY" "$DVM_INPUT" "$test_root/unpaid.json" <<'NODE'
import { writeFileSync } from "node:fs";
const [endpoint, capability, input, output] = process.argv.slice(2);
const response = await fetch(`${endpoint}/v1/job`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({capability,data:JSON.parse(input)}), signal:AbortSignal.timeout(5000) });
const body=await response.json();
if(response.status!==402 || body.error!=="payment_required" || !Number.isSafeInteger(body.required_msats) || body.required_msats<=0) throw Error(`expected valid 402, got ${response.status} ${JSON.stringify(body)}`);
writeFileSync(output,JSON.stringify(body));
NODE

npm install --ignore-scripts --prefix "$test_root/tools" @dvmkit/dvm-cli@0.7.0
export PATH="$test_root/tools/node_modules/.bin:$PATH"
dvm init
dvm wallet x402-connect --key-file "$X402_TESTNET_KEY_FILE" --network "eip155:84532"
dvm wallet balance >"$test_root/balance.json"
dvm request --endpoint "$dvm_endpoint" --data "$DVM_INPUT" --rail x402 \
  --budget "$DVM_PAYMENT_CAP" --auto-pay-below "$DVM_PAYMENT_CAP" \
  --max-increment "$DVM_PAYMENT_CAP" --max-payments 1 </dev/null >"$test_root/paid.json"
job_id="$(node -p 'require(process.argv[1]).jobId' "$test_root/paid.json")"
result_dir="$PWD/.dvmkit-test-results/$job_id"
mkdir -p -m 700 "$result_dir"
cp "$test_root/unpaid.json" "$test_root/paid.json" "$result_dir/"
dvm messages "$job_id" --no-stream >/dev/null
TMPDIR="$result_dir" dvm messages "$job_id" --no-stream --human | tee "$result_dir/artifacts.txt"
retained_config="$result_dir/caller"
node - "$DVM_CONFIG_DIR" "$retained_config" "$result_dir/messages.json" "$job_id" <<'NODE'
const { mkdirSync, readFileSync, writeFileSync }=require("node:fs");const { join }=require("node:path");const [source,destination,resultPath,jobId]=process.argv.slice(2);
const job=JSON.parse(readFileSync(join(source,"jobs.json"),"utf8")).find(item=>item.id===jobId);if(!job)throw Error(`caller state did not retain ${jobId}`);
const receipts=readFileSync(join(source,"receipts.jsonl"),"utf8").trim().split("\n").filter(Boolean).filter(line=>JSON.parse(line).receipt?.job_id===jobId);if(receipts.length!==1)throw Error(`expected one receipt for ${jobId}, found ${receipts.length}`);
const messages=readFileSync(join(source,"messages",`${jobId}.jsonl`),"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));const retainedMessages=messages.filter(message=>["text","artifact","complete","cancel"].includes(message.type));if(!retainedMessages.some(message=>message.type==="complete"||message.type==="cancel"))throw Error("caller state did not retain a terminal message");
const retainedJob={id:job.id,endpoint:job.endpoint,status:job.status,submittedAt:job.submittedAt,completedAt:job.completedAt,completion:job.completion,paymentsHonoured:job.paymentsHonoured,policy:job.policy};mkdirSync(join(destination,"messages"),{recursive:true,mode:0o700});
writeFileSync(join(destination,"jobs.json"),`${JSON.stringify([retainedJob])}\n`,{mode:0o600});writeFileSync(join(destination,"receipts.jsonl"),`${receipts[0]}\n`,{mode:0o600});writeFileSync(join(destination,"messages",`${jobId}.jsonl`),`${retainedMessages.map(message=>JSON.stringify(message)).join("\n")}\n`,{mode:0o600});writeFileSync(resultPath,`${JSON.stringify({jobId,messages:retainedMessages})}\n`,{mode:0o600});
NODE
DVM_CONFIG_DIR="$retained_config" dvm receipts verify "$job_id" >"$result_dir/verified.json"
node - "$result_dir/unpaid.json" "$result_dir/paid.json" "$result_dir/messages.json" "$result_dir/verified.json" <<'NODE'
const [challengePath,paidPath,messagesPath,verifiedPath]=process.argv.slice(2);const challenge=require(challengePath),paid=require(paidPath),messages=require(messagesPath),verified=require(verifiedPath);
const validReceiptStatuses=new Set(["verified","verified_unattested"]);
if(!paid.jobId || paid.next_action!==null || !validReceiptStatuses.has(paid.receipt_verified)) throw Error("paid result is not terminal with a valid receipt signature");
const receipt=paid.receipt;
if(receipt?.outcome!=="completed" || receipt?.paid?.rail!=="x402" || receipt.paid.msats!==challenge.required_msats) throw Error("receipt is not quote-bound x402");
if(receipt.paid.native_amount!==10000 || receipt.paid.native_asset!=="usdc") throw Error("$0.01 must settle as exactly 10000 micro-USDC");
if(!messages.messages?.some(message=>message.type==="complete")) throw Error("paid messages did not complete");
if((paid.has_artifacts || paid.artifact_count>0) && !messages.messages?.some(message=>message.type==="artifact")) throw Error("paid result advertised an artifact that was not retrieved");
if(verified.job_id!==paid.jobId || !validReceiptStatuses.has(verified.receipt_verified) || verified.receipt_checks?.result_hash!=="ok") throw Error("stored receipt and paid result hash did not verify");
NODE
cat "$result_dir/paid.json"
printf '\nPaid result and artifact evidence retained in %s\n' "$result_dir"
```

Stop on a missing balance, RPC/facilitator failure, or cap refusal. Do not replace the network, key, or cap without new approval.
