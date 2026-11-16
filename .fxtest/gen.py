#!/usr/bin/env python3
"""gen.py tcp HOST PORT UP_BYTES DOWN_BYTES [CONNS]
   gen.py udp HOST PORT PACKETS SIZE [PPS]
Prints a JSON line with payload bytes actually sent and received."""
import json, socket, struct, sys, threading, time

def tcp_one(host, port, up, down, out):
    s = socket.create_connection((host, port), timeout=20)
    s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    s.sendall(struct.pack("!Q", down))
    sent = 8; got = 0; chunk = b"\x5a" * 65536
    def reader():
        nonlocal got
        while True:
            try: d = s.recv(1 << 16)
            except OSError: break
            if not d: break
            got += len(d)
    t = threading.Thread(target=reader, daemon=True); t.start()
    left = up
    while left > 0:
        n = min(left, len(chunk)); s.sendall(chunk[:n]); left -= n; sent += n
    s.shutdown(socket.SHUT_WR)
    t.join(120); s.close()
    out.append((sent, got))

def main():
    mode, host, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
    t0 = time.time()
    if mode == "tcp":
        up, down = int(sys.argv[4]), int(sys.argv[5]); conns = int(sys.argv[6]) if len(sys.argv) > 6 else 1
        out = []; ths = []
        for _ in range(conns):
            th = threading.Thread(target=tcp_one, args=(host, port, up // conns, down // conns, out)); th.start(); ths.append(th)
            if conns > 20: time.sleep(0.01)
        for th in ths: th.join(180)
        print(json.dumps({"mode": "tcp", "conns": conns, "ok": len(out), "sent": sum(o[0] for o in out), "recv": sum(o[1] for o in out), "secs": round(time.time() - t0, 2)}))
    else:
        packets, size = int(sys.argv[4]), int(sys.argv[5]); pps = int(sys.argv[6]) if len(sys.argv) > 6 else 2000
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
        u.connect((host, port)); u.settimeout(0.002)
        payload = b"\x3c" * size; got = 0; gotp = 0; interval = 1.0 / pps
        for i in range(packets):
            u.send(payload)
            try:
                while True:
                    d = u.recv(65535); got += len(d); gotp += 1
            except (socket.timeout, BlockingIOError, ConnectionRefusedError):
                pass
            time.sleep(interval)
        u.settimeout(3)
        try:
            while True:
                d = u.recv(65535); got += len(d); gotp += 1
        except (socket.timeout, ConnectionRefusedError):
            pass
        print(json.dumps({"mode": "udp", "sent": packets * size, "sentPackets": packets, "recv": got, "recvPackets": gotp, "secs": round(time.time() - t0, 2)}))

main()
