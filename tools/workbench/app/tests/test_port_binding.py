"""Loopback port binding must never share or take over a live listener (check-then-bind race on Windows).
Ephemeral ports only; never invokes Codex and never touches a server on 7816."""
import http.client
import os
import socket
import sys
import threading
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
import server

class PortBindingTests(unittest.TestCase):
    def setUp(self):
        self.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler);self.port=self.http.server_port
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):self.http.shutdown();self.http.server_close();self.thread.join()
    def status(self):
        c=http.client.HTTPConnection('127.0.0.1',self.port,timeout=5)
        try:c.request('GET','/',headers={'Host':f'127.0.0.1:{self.port}'});return c.getresponse().status
        finally:c.close()
    def test_literal_loopback_bind(self):
        self.assertEqual(self.http.server_address[0],'127.0.0.1')
        self.assertTrue(issubclass(server.ThreadingHTTPServer,server._NativeThreadingHTTPServer))
    @unittest.skipUnless(os.name=='nt','Windows exclusive-bind flags')
    def test_windows_socket_flags_exclusive_without_reuse(self):
        self.assertFalse(server.ThreadingHTTPServer.allow_reuse_address)
        self.assertEqual(self.http.socket.getsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR),0)
        self.assertNotEqual(self.http.socket.getsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE),0)
    @unittest.skipIf(os.name=='nt','non-Windows keeps stdlib restart behavior')
    def test_posix_keeps_stdlib_reuse_default(self):
        self.assertTrue(server.ThreadingHTTPServer.allow_reuse_address)
    def test_second_identical_bind_fails_and_first_still_serves(self):
        before=self.status()
        with self.assertRaises(OSError):server.ThreadingHTTPServer(('127.0.0.1',self.port),server.Handler)
        self.assertEqual(self.status(),before)
    def test_reuseaddr_socket_cannot_take_over_listener(self):
        s=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
        try:
            s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            with self.assertRaises(OSError):s.bind(('127.0.0.1',self.port))
        finally:s.close()
        self.assertLess(self.status(),500)

if __name__=='__main__':unittest.main()
