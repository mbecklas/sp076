"""Receives print files from tools/render-prints.html and writes them into prints/.

Run it from the project folder, then open tools/render-prints.html through the
local preview server (http://localhost:5174/tools/render-prints.html):

    python tools/save_prints.py

It only listens on 127.0.0.1 and only writes inside prints/.
"""
import http.server
import pathlib
import sys
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent / "prints"
PORT = 5175


class Handler(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        query = urllib.parse.urlparse(self.path).query
        name = urllib.parse.parse_qs(query).get("name", [""])[0]
        target = (ROOT / name).resolve()
        if not name or ROOT not in target.parents:
            self.send_response(400)
            self._cors()
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.rfile.read(length))
        self.send_response(200)
        self._cors()
        self.end_headers()
        self.wfile.write(b"ok")
        if name == "manifest.json":
            print("manifest written, all done", flush=True)

    def log_message(self, fmt, *args):
        sys.stdout.write("saved " + urllib.parse.unquote(self.path.split("name=")[-1]) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    ROOT.mkdir(exist_ok=True)
    print(f"Saving print files into {ROOT} (listening on 127.0.0.1:{PORT})", flush=True)
    http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
