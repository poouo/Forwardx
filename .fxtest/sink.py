#!/usr/bin/env python3
"""Traffic sink on the target. TCP: reads an 8-byte download size, then sends that
many bytes while counting everything uploaded until EOF. UDP: echoes each datagram."""
import socket, struct, threading, sys
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9000
CHUNK = b"\xa5" * 65536

def tcp_client(conn):
    try:
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        head = b""
        while len(head) < 8:
            part = conn.recv(8 - len(head))
            if not part: return
            head += part
        download = struct.unpack("!Q", head)[0]
        def sender():
            left = download
            try:
                while left > 0:
                    n = min(left, len(CHUNK))
                    conn.sendall(CHUNK[:n]); left -= n
            except OSError:
                pass
        t = threading.Thread(target=sender, daemon=True); t.start()
        while conn.recv(1 << 16):
            pass
        t.join()
        conn.shutdown(socket.SHUT_WR)
        conn.settimeout(10)
        try:
            while conn.recv(4096): pass
        except OSError: pass
    finally:
        conn.close()

def tcp_loop():
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", PORT)); s.listen(256)
    while True:
        c, _ = s.accept()
        threading.Thread(target=tcp_client, args=(c,), daemon=True).start()

def udp_loop():
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    u.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
    u.bind(("0.0.0.0", PORT))
    while True:
        data, addr = u.recvfrom(65535)
        u.sendto(data, addr)

threading.Thread(target=udp_loop, daemon=True).start()
tcp_loop()
