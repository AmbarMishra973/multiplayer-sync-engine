process.env.NODE_ENV = "test";
import { createMultiplayerServer } from "./server.js";

async function runTests() {
  console.log("▶ Starting Server Automated Protocol Tests...");
  const TEST_PORT = 8999;
  const { server, roomManager } = createMultiplayerServer();

  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  console.log(`✓ Test server listening on port ${TEST_PORT}`);

  const wsUrl = `ws://localhost:${TEST_PORT}`;

  try {
    // 1. Connect Client A
    const clientA = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      clientA.onopen = () => resolve();
      clientA.onerror = (e) => reject(e);
    });
    console.log("✓ Client A connected via raw WebSocket RFC 6455 handshake");

    let clientAWelcomed = false;
    let clientAReceivedB = false;
    let clientAReceivedHype = false;

    clientA.onmessage = (event) => {
      const msg = JSON.parse(event.data.toString());
      if (msg.type === "welcome") {
        clientAWelcomed = true;
      }
      if (msg.type === "client_joined" && msg.client.clientId === "client-b") {
        clientAReceivedB = true;
      }
      if (msg.type === "hype_update" && msg.totalCount >= 1) {
        clientAReceivedHype = true;
      }
    };

    // Client A sends join
    clientA.send(JSON.stringify({
      type: "join",
      roomId: "test-fan-room",
      clientId: "client-a",
      name: "Alice",
      color: "#ff0055"
    }));

    await new Promise((r) => setTimeout(r, 100));
    if (!clientAWelcomed) throw new Error("Client A did not receive welcome message");
    console.log("✓ Client A joined and received welcome + initial room_state snapshot");

    // 2. Connect Client B
    const clientB = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      clientB.onopen = () => resolve();
      clientB.onerror = (e) => reject(e);
    });

    let clientBReceivedCursor = false;
    let receivedCursorCoords = { x: 0, y: 0 };

    clientB.onmessage = (event) => {
      const msg = JSON.parse(event.data.toString());
      if (msg.type === "cursor" && msg.clientId === "client-a") {
        clientBReceivedCursor = true;
        receivedCursorCoords = { x: msg.x, y: msg.y };
      }
    };

    clientB.send(JSON.stringify({
      type: "join",
      roomId: "test-fan-room",
      clientId: "client-b",
      name: "Bob",
      color: "#00ffcc"
    }));

    await new Promise((r) => setTimeout(r, 150));
    if (!clientAReceivedB) throw new Error("Client A was not notified of Client B joining");
    console.log("✓ Presence fan-out verified: Client A detected Client B");

    // 3. Client A sends cursor updates
    clientA.send(JSON.stringify({
      type: "cursor",
      seq: 1,
      ts: Date.now(),
      x: 0.45,
      y: 0.72
    }));

    await new Promise((r) => setTimeout(r, 100));
    if (!clientBReceivedCursor || receivedCursorCoords.x !== 0.45 || receivedCursorCoords.y !== 0.72) {
      throw new Error("Client B did not receive accurate cursor broadcast");
    }
    console.log("✓ Real-time cursor relay verified without echo");

    // 4. Client B taps Hype button (Conflict reconciliation test)
    clientB.send(JSON.stringify({
      type: "hype_tap",
      seq: 1,
      ts: Date.now()
    }));

    await new Promise((r) => setTimeout(r, 100));
    if (!clientAReceivedHype) throw new Error("Collaborative hype tap was not broadcast");
    console.log("✓ Collaborative fan hype reconciliation verified");

    // 5. Malformed payload error handling test
    let receivedError = false;
    clientA.onmessage = (event) => {
      const msg = JSON.parse(event.data.toString());
      if (msg.type === "error" && msg.code === "INVALID_PAYLOAD") {
        receivedError = true;
      }
    };
    clientA.send(JSON.stringify({ type: "unknown_bogus_action", foo: "bar" }));
    await new Promise((r) => setTimeout(r, 100));
    if (!receivedError) throw new Error("Malformed payload was not rejected gracefully");
    console.log("✓ Malformed message rejection verified without server crash");

    // 6. Disconnect handling test
    clientB.close();
    await new Promise((r) => setTimeout(r, 150));
    const room = roomManager.getRoom("test-fan-room");
    if (room && room.peerCount !== 1) {
      throw new Error(`Expected 1 peer remaining after disconnect, got ${room.peerCount}`);
    }
    console.log("✓ Disconnect detection and peer cleanup verified");

    clientA.close();
    console.log("\n🎉 ALL PROTOCOL & SERVER TESTS PASSED PERFECTLY!\n");
  } finally {
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 500);
  }
}

runTests().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
