const { session, BrowserWindow } = require('electron');

class ChatGPTAuth {
  constructor(mainWindow, { sessionApi = session.defaultSession, BrowserWindowClass = BrowserWindow } = {}) {
    this.mainWindow = mainWindow;
    this.authWindow = null;
    this.accessToken = null;
    this.accountId = null;
    this.accessTokenRefresh = null;
    this.session = sessionApi;
    this.BrowserWindowClass = BrowserWindowClass;
  }

  getBrowserUserAgent() {
    const raw = this.session.getUserAgent();
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
    this.accountId = null;
    if (this.authWindow) {
      this.authWindow.close();
      this.authWindow = null;
    }
    if (!hardReset) return;

    const ses = this.session;
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

  captureSessionState(data) {
    if (!data || typeof data !== 'object') return;
    if (data.accessToken) this.accessToken = data.accessToken;
    const accountId = data.account?.id
      || data.account_id
      || data.active_account_id
      || data.activeAccountId
      || this.extractAccountIdFromAccessToken(data.accessToken)
      || null;
    if (accountId) this.accountId = String(accountId);
  }

  extractAccountIdFromAccessToken(accessToken) {
    try {
      const payload = String(accessToken || '').split('.')[1];
      if (!payload) return null;
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const authClaims = claims?.['https://api.openai.com/auth'] || {};
      return authClaims.chatgpt_account_id
        || authClaims.account_id
        || claims.chatgpt_account_id
        || claims.account_id
        || null;
    } catch {
      return null;
    }
  }

  async login() {
    if (this.authWindow) return;

    return new Promise((resolve) => {
      this.authWindow = new this.BrowserWindowClass({
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
          const sessionResp = await this.session.fetch('https://chatgpt.com/api/auth/session');
          if (sessionResp.ok) {
            const data = await sessionResp.json();
            if (data.accessToken) {
              this.captureSessionState(data);
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

  async getAccessToken({ forceRefresh = false } = {}) {
    if (forceRefresh) this.accessToken = null;
    if (!this.accessToken && !this.accessTokenRefresh) {
      this.accessTokenRefresh = (async () => {
        try {
          const sessionResp = await this.session.fetch('https://chatgpt.com/api/auth/session');
          if (sessionResp.ok) {
            const data = await sessionResp.json();
            this.captureSessionState(data);
            if (!data.accessToken) this.accessToken = null;
          }
        } catch (e) {
          console.error('Failed to get session token:', e);
        } finally {
          this.accessTokenRefresh = null;
        }
      })();
    }
    if (this.accessTokenRefresh) await this.accessTokenRefresh;
    return this.accessToken;
  }

  async getIdentity() {
    try {
      const sessionResp = await this.session.fetch('https://chatgpt.com/api/auth/session');
      if (!sessionResp.ok) return null;
      const data = await sessionResp.json();
      this.captureSessionState(data);
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
      const cookies = await this.session.cookies.get({ domain: 'chatgpt.com', name: 'oai-did' });
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

    const performFetch = async (accessToken) => {
      const deviceId = await this.getDeviceId();
      const headers = {
        ...this.getBaseHeaders(),
        'Authorization': `Bearer ${accessToken}`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Priority': 'u=1, i',
        ...options.headers,
      };

      if (deviceId) headers['oai-device-id'] = deviceId;
      if (this.accountId) headers['chatgpt-account-id'] = this.accountId;
      const hasContentType = Object.keys(headers).some(
        key => key.toLowerCase() === 'content-type'
      );
      if (options.body && !hasContentType) headers['Content-Type'] = 'application/json';
      return this.session.fetch(url, { ...options, headers });
    };

    const response = await performFetch(token);
    const replayableBody = options.body == null
      || typeof options.body === 'string'
      || Buffer.isBuffer(options.body)
      || options.body instanceof ArrayBuffer
      || options.body instanceof URLSearchParams;
    if (response.status !== 401 || !replayableBody) return response;

    // Session cookies can outlive the in-memory bearer token. Refresh once on
    // authorization failure so a normal token rotation does not require an app restart.
    if (this.accessToken === token) this.accessToken = null;
    const refreshedToken = await this.getAccessToken();
    if (!refreshedToken) return response;
    return performFetch(refreshedToken);
  }
}

module.exports = ChatGPTAuth;
