#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""3D 钢琴演奏台 本地服务器：静态资源 + 可选任意路径文件服务"""
import http.server, socketserver, os, sys, json, mimetypes

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.abspath(__file__))

mimetypes.add_type('model/gltf-binary', '.glb')
mimetypes.add_type('audio/ogg', '.ogg')

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write('[server] %s\n' % (fmt % args))

def main():
    # pick a free port if occupied
    port = PORT
    for _ in range(20):
        try:
            httpd = socketserver.ThreadingTCPServer(('127.0.0.1', port), Handler)
            break
        except OSError:
            port += 1
    print('3D Piano server running at http://127.0.0.1:%d  (root: %s)' % (port, ROOT))
    print('Press Ctrl+C to stop.')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped.')
        httpd.shutdown()

if __name__ == '__main__':
    main()
