"""Checks a restored database against the data dump it came from: every table that has rows in the dump must exist
in the restored database with exactly the same number of rows. Prints a Markdown summary (counts only, no data).
Exits non-zero on any mismatch, which fails the backup run."""
import re, subprocess, sys

dump, url = sys.argv[1], sys.argv[2]
counts, current = {}, None
with open(dump, encoding="utf-8", errors="replace") as f:
    for line in f:
        if current is None:
            m = re.match(r'COPY\s+("?[\w]+"?)\."?([\w]+)"?\s.*FROM stdin;', line)
            if m:
                current = f'{m.group(1).strip(chr(34))}.{m.group(2)}'
                counts[current] = 0
        elif line.rstrip("\n") == "\\.":
            current = None
        else:
            counts[current] += 1

if not counts:
    print("No table data found in the dump."); sys.exit(1)

def restored(table):
    schema, name = table.split(".", 1)
    q = f'select count(*) from "{schema}"."{name}"'
    r = subprocess.run(["psql", url, "-At", "-c", q], capture_output=True, text=True)
    return int(r.stdout.strip()) if r.returncode == 0 else None

bad, rows = [], []
for t in sorted(counts):
    got = restored(t)
    ok = got == counts[t]
    if not ok: bad.append(t)
    rows.append(f"| {t} | {counts[t]} | {got if got is not None else 'missing'} | {'✅' if ok else '❌'} |")

print(f"### Restore test: {'passed' if not bad else 'FAILED'}\n")
print(f"{len(counts)} tables, {sum(counts.values())} rows in the dump.\n")
print("| Table | Rows in dump | Rows restored | |\n|---|---:|---:|---|")
print("\n".join(rows))
if bad:
    print(f"\n**Mismatch:** {', '.join(bad)}")
    sys.exit(1)
