// Remote control: a small web page, served by the app, for following and steering sessions from another device.
// Off until the user turns it on. Types only.

export interface RemoteStatus {
  /** The setting */
  enabled: boolean;
  /** The server is listening */
  running: boolean;
  /** localhost: this Mac only. lan: other devices on the same network. */
  bind: 'localhost' | 'lan';
  port: number | null;
  /** Links that open the remote page, access token included; one per address the server answers on */
  urls: string[];
  /** Devices connected right now */
  clients: number;
  startedAt?: number;
  /** Why it could not start */
  error?: string;
}

export interface RemoteRpc {
  'remote.status': () => RemoteStatus;
  /** Turns it on (and saves the setting) */
  'remote.start': () => RemoteStatus;
  'remote.stop': () => RemoteStatus;
  /** Changes where it listens; restarts the server when it is running */
  'remote.configure': (patch: { bind?: 'localhost' | 'lan'; port?: number }) => RemoteStatus;
  /** Replaces the access token: every link handed out so far stops working */
  'remote.newLink': () => RemoteStatus;
}

export interface RemoteEvents {
  'remote:changed': RemoteStatus;
}
