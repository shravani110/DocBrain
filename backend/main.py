"""Engine entry point.

Run: python backend/main.py [--port 8756] [--lan]

By default the server binds to 127.0.0.1 only: nothing is reachable from the
network, which is the app's core privacy promise. `--lan` is the explicit
opt-in for using DocBrain from a phone or tablet on the SAME trusted Wi-Fi --
it binds to all interfaces, so anyone on that network can reach your
documents. Never use it on public networks.
"""
import argparse
import socket

import uvicorn

from app.api import app  # noqa: F401


def _lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # no traffic sent; just picks the LAN interface
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "<your-computer's-IP>"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8756)
    parser.add_argument(
        "--lan",
        action="store_true",
        help="Also accept connections from other devices on your local network "
        "(phone/tablet). Only use on a trusted network.",
    )
    args = parser.parse_args()

    host = "0.0.0.0" if args.lan else "127.0.0.1"
    if args.lan:
        print("!" * 68)
        print("  LAN mode: DocBrain is reachable by ANY device on this network.")
        print(f"  On your phone/tablet, open:  http://{_lan_ip()}:{args.port}")
        print("  Only use this on a network you trust (home Wi-Fi).")
        print("!" * 68)

    uvicorn.run(app, host=host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
