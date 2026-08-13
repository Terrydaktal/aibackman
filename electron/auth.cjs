const { session, BrowserWindow } = require('electron');

class ChatGPTAuth {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.authWindow = null;
    this.accessToken = null;
  }

  getBrowserUserAgent() {
    const raw = session.defaultSession.getUserAgent();
    return raw.replace(/\sElectron\/[^\s]+/i, '').trim();
  }

  getBaseHeaders() {
    return {
      'User-Agent': this.getBrowserUserAgent(),
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      Origin: 'https://chatgpt.com',
      Referer: 'https://chatgpt.com/',
      Accept: 'application/json, text/plain, */*',
    };
  }

  async clearAuthState({ hardReset = false } = {}) {
    this.accessToken = null;
    if (this.authWindow) {
      this.authWindow.close();
      this.authWindow = null;
    }
    if (!hardReset) return;

    const ses = session.defaultSession;
    const origins = ['https://chatgpt.com', 'https://chat.openai.com', 'https://auth.openai.com'];
    const storages = ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'];

    for (const origin of origins) {
      try {
        await ses.clearStorageData({ origin, storages });
      } catch (error) {
        console.warn(`Failed to clear storage for ${origin}:`, error);
      }
    }

    try {
      const cookies = await ses.cookies.get({});
      for (const cookie of cookies) {
        const domain = String(cookie.domain || '').replace(/^\./, '');
        if (!domain.endsWith('chatgpt.com') && !domain.endsWith('openai.com')) continue;
        const proto = cookie.secure ? 'https' : 'http';
        const url = `${proto}://${domain}${cookie.path || '/'}`;
        try {
          await ses.cookies.remove(url, cookie.name);
        } catch (error) {
          console.warn(`Failed to remove cookie ${cookie.name} for ${domain}:`, error);
        }
      }
    } catch (error) {
      console.warn('Failed to enumerate cookies for hard reset:', error);
    }
  }

  async login() {
    if (this.authWindow) return;

    return new Promise((resolve) => {
      this.authWindow = new BrowserWindow({
        width: 800,
        height: 900,
        title: 'Login to ChatGPT',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      this.authWindow.webContents.setUserAgent(this.getBrowserUserAgent());
      // Handle popups (Google/Apple login often use them)
      this.authWindow.webContents.setWindowOpenHandler(({ url }) => {
        return { action: 'allow' };
      });

      this.authWindow.loadURL('https://chatgpt.com/auth/login');

      const checkAuth = async () => {
        try {
          // Check if we can get a session via the internal endpoint
          const sessionResp = await session.defaultSession.fetch('https://chatgpt.com/api/auth/session');
          if (sessionResp.ok) {
            const data = await sessionResp.json();
            if (data.accessToken) {
              this.accessToken = data.accessToken;
              console.log('Successfully captured access token');
              if (this.authWindow) {
                this.authWindow.close();
              }
              resolve(true);
              return;
            }
          }
        } catch (e) {
          // Not logged in yet or network error
        }
      };

      this.authWindow.webContents.on('did-finish-load', checkAuth);
      this.authWindow.webContents.on('did-navigate', checkAuth);
      
      this.authWindow.on('closed', () => {
        this.authWindow = null;
        resolve(!!this.accessToken);
      });
    });
  }

  async reauthenticate(options = {}) {
    await this.clearAuthState(options);
    return this.login();
  }

  async getAccessToken() {
    if (!this.accessToken) {
      try {
        const sessionResp = await session.defaultSession.fetch('https://chatgpt.com/api/auth/session');
        if (sessionResp.ok) {
          const data = await sessionResp.json();
          this.accessToken = data.accessToken;
        }
      } catch (e) {
        console.error('Failed to get session token:', e);
      }
    }
    return this.accessToken;
  }

  async getIdentity() {
    try {
      const sessionResp = await session.defaultSession.fetch('https://chatgpt.com/api/auth/session');
      if (!sessionResp.ok) return null;
      const data = await sessionResp.json();
      const candidates = [data?.user, data?.account, data?.profile, data].filter(Boolean);
      const email = candidates.map((candidate) => (
        candidate.email || candidate.email_address || candidate.username || ''
      )).find((value) => /@/.test(String(value))) || '';
      const name = candidates.map((candidate) => (
        candidate.name || candidate.display_name || candidate.full_name || ''
      )).find((value) => String(value).trim()) || '';
      if (!email && !name) return null;
      return { email: String(email).trim(), name: String(name).trim() };
    } catch {
      return null;
    }
  }

  async getDeviceId() {
    try {
      const cookies = await session.defaultSession.cookies.get({ domain: 'chatgpt.com', name: 'oai-did' });
      if (cookies.length > 0) {
        return cookies[0].value;
      }
    } catch (e) {
      console.warn('Failed to get oai-did cookie:', e);
    }
    return null;
  }

  async fetchWithAuth(url, options = {}) {
    const token = await this.getAccessToken();
    if (!token) throw new Error('Not authenticated');

    const deviceId = await this.getDeviceId();

    const headers = {
      ...this.getBaseHeaders(),
      'Authorization': `Bearer ${token}`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Priority': 'u=1, i',
      ...options.headers,
    };

    if (deviceId) {
      headers['oai-device-id'] = deviceId;
    }

    const hasContentType = Object.keys(headers).some(
      key => key.toLowerCase() === 'content-type'
    );
    if (options.body && !hasContentType) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await session.defaultSession.fetch(url, {
      ...options,
      headers,
    });

    return response;
  }
}

module.exports = ChatGPTAuth;
