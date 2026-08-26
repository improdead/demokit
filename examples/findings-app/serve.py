"""A deliberately EMPTY production-like app: the findings list is genuinely
empty, but the patch generator (the payoff) really works server-side. That is
exactly the shape the mock-data policy has to handle: seed the inputs, never
fabricate the payoff."""
import http.server, json, socketserver, os, time, re

FIXES = {
  'sqli': ('services/billing/queries.py',
    "@@ -41,7 +41,10 @@ def invoices_for(org_id, status):\n"
    "-    q = f\"SELECT * FROM invoices WHERE org_id = '{org_id}' AND status = '{status}'\"\n"
    "-    return db.execute(q).fetchall()\n"
    "+    q = (\n"
    "+        \"SELECT * FROM invoices WHERE org_id = %(org)s AND status = %(status)s\"\n"
    "+    )\n"
    "+    return db.execute(q, {\"org\": org_id, \"status\": status}).fetchall()"),
  'ssrf': ('services/webhooks/dispatch.go',
    "@@ -88,6 +88,9 @@ func Dispatch(ctx context.Context, target string) error {\n"
    "-\tresp, err := http.Get(target)\n"
    "+\tif err := guard.DenyInternal(target); err != nil {\n"
    "+\t\treturn fmt.Errorf(\"dispatch blocked: %w\", err)\n"
    "+\t}\n"
    "+\tresp, err := safeClient.Get(ctx, target)"),
}
def fix_for(fid):
    slug = fid.rsplit('_', 1)[-1]
    return FIXES.get(slug, FIXES['sqli'])

class H(http.server.SimpleHTTPRequestHandler):
    def _j(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.startswith('/api/findings'):
            return self._j({'findings': []})          # empty production tenant
        return super().do_GET()
    def do_POST(self):
        m = re.match(r'/api/findings/([\w-]+)/patch', self.path)
        if m:
            time.sleep(1.1)                            # real work, real latency
            f, d = fix_for(m.group(1))
            return self._j({'file': f, 'diff': d})
        return self._j({}, 404)
    def log_message(self, *a): pass

os.chdir(os.path.dirname(os.path.abspath(__file__)))
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', 8893), H) as s:
    s.serve_forever()
