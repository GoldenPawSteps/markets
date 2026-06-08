# app/ws.py
from __future__ import annotations
import json
from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: dict[WebSocket, set[str]] = {}

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.connections[ws] = {"feed"}

    def disconnect(self, ws: WebSocket) -> None:
        self.connections.pop(ws, None)

    def subscribe(self, ws: WebSocket, topic: str) -> None:
        if ws in self.connections:
            self.connections[ws].add(topic)

    def unsubscribe(self, ws: WebSocket, topic: str) -> None:
        if ws in self.connections:
            self.connections[ws].discard(topic)

    async def publish(self, topic: str, message: dict) -> None:
        data = json.dumps(message, default=str)
        for ws, topics in list(self.connections.items()):
            if topic in topics:
                try:
                    await ws.send_text(data)
                except Exception:
                    self.disconnect(ws)


manager = ConnectionManager()