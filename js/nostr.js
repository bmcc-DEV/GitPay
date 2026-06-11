// js/nostr.js - Simple browser-based Nostr client using standard WebSockets

class NostrClient {
  constructor(relays = []) {
    this.relays = relays.length > 0 ? relays : [
      'wss://nos.lol',
      'wss://relay.damus.io',
      'wss://relay.snort.social'
    ];
    this.sockets = new Map();
    this.subscriptions = new Map(); // subId -> { filter, callback }
  }

  connectAll() {
    this.relays.forEach(url => {
      this.connect(url);
    });
  }

  connect(url) {
    if (this.sockets.has(url)) {
      const ws = this.sockets.get(url);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        return;
      }
    }

    console.log(`[Nostr] Connecting to relay: ${url}`);
    try {
      const ws = new WebSocket(url);
      
      ws.onopen = () => {
        console.log(`[Nostr] Connected to relay: ${url}`);
        this.sockets.set(url, ws);
        
        // Re-subscribe to active subscriptions
        for (const [subId, sub] of this.subscriptions.entries()) {
          ws.send(JSON.stringify(['REQ', subId, sub.filter]));
        }
      };

      ws.onclose = () => {
        console.log(`[Nostr] Connection closed by relay: ${url}. Reconnecting in 5s...`);
        this.sockets.delete(url);
        setTimeout(() => this.connect(url), 5000);
      };

      ws.onerror = (err) => {
        console.warn(`[Nostr] Error on relay ${url}:`, err);
        ws.close();
      };

      ws.onmessage = (e) => {
        try {
          const message = JSON.parse(e.data);
          const type = message[0];
          
          if (type === 'EVENT') {
            const subId = message[1];
            const event = message[2];
            const sub = this.subscriptions.get(subId);
            if (sub && typeof sub.callback === 'function') {
              sub.callback(event);
            }
          }
        } catch (err) {
          console.error('[Nostr] Failed to parse message:', err);
        }
      };

    } catch (err) {
      console.error(`[Nostr] Failed to connect to ${url}:`, err);
      setTimeout(() => this.connect(url), 5000);
    }
  }

  publish(event) {
    console.log('[Nostr] Publishing event:', event.id);
    const payload = JSON.stringify(['EVENT', event]);
    let count = 0;
    this.sockets.forEach((ws, url) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
          count++;
        } catch (e) {
          console.warn(`[Nostr] Failed to send to ${url}:`, e);
        }
      }
    });
    console.log(`[Nostr] Event sent to ${count} relays.`);
    return count;
  }

  subscribe(subId, filter, callback) {
    console.log(`[Nostr] Subscribing with ID ${subId}:`, filter);
    this.subscriptions.set(subId, { filter, callback });
    
    const payload = JSON.stringify(['REQ', subId, filter]);
    this.sockets.forEach((ws, url) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
        } catch (e) {
          console.warn(`[Nostr] Failed to subscribe on ${url}:`, e);
        }
      }
    });
  }

  unsubscribe(subId) {
    console.log(`[Nostr] Unsubscribing from ID ${subId}`);
    this.subscriptions.delete(subId);
    
    const payload = JSON.stringify(['CLOSE', subId]);
    this.sockets.forEach((ws, url) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
        } catch (e) {
          console.warn(`[Nostr] Failed to close subscription on ${url}:`, e);
        }
      }
    });
  }
  
  disconnectAll() {
    this.sockets.forEach((ws) => {
      try {
        ws.close();
      } catch(e) {}
    });
    this.sockets.clear();
    this.subscriptions.clear();
  }
}
