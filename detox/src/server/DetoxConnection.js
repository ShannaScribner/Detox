const _ = require('lodash');
const log = require('../utils/logger').child({ __filename });
const { WebSocket } = require('ws');

const J = (obj) => JSON.stringify(obj, null, 2);

class DetoxConnection {
  /**
   * @param {DetoxSessionManager} sessionManager
   * @param {WebSocket} ws
   */
  constructor(sessionManager, ws) {
    this._onMessage = this._onMessage.bind(this);
    this._onError = this._onError.bind(this);
    this._onClose = this._onClose.bind(this);

    this.__sessionMemo = null;
    this._sessionManager = sessionManager;
    this._ws = ws;
    this._ws.on('message', this._onMessage);
    this._ws.on('error', this._onError);
    this._ws.on('close', this._onClose);

    this.__sendActionPromise = Promise.resolve();
  }

  sendAction(action) {
    this.__sendActionPromise = this.__sendActionPromise.then(() => {
      return this._doSendAction(action);
    });
  }

  /** @type {DetoxSession | null} **/
  get _session() {
    if (!this.__sessionMemo) {
      this.__sessionMemo = this._sessionManager.getSession(this);
    }

    return this.__sessionMemo;
  }

  get _role() {
    return this._session ? this._session.getRole(this) : undefined;
  }

  get _sessionId() {
    return this._session ? this._session.id : undefined;
  }

  _doSendAction(action) {
    return new Promise((resolve) => {
      this._ws.send(JSON.stringify(action) + '\n ', {}, resolve);
    });
  }

  _onMessage(data) {
    this.__sessionMemo = null; // invalidate cache

    const action = _.attempt(() => JSON.parse(data));
    if (_.isError(action)) {
      return this._handleInvalidMessage(data);
    }

    try {
      this._handleAction(action);
    } catch (e) {
      this._handleActionError(e, action);
    }
  }

  _onError(e) {
    this.__sessionMemo = null; // invalidate cache

    const role = this._role;
    const sessionId = this._sessionId;
    const details = {
      event: 'WEBSOCKET_ERROR',
      role,
      sessionId,
    };

    log.warn(details, `${e && e.message} (role=${role}, session=${sessionId})`);
  }

  _onClose() {
    this.__sessionMemo = null; // invalidate cache

    this._sessionManager.unregisterConnection(this);
  }

  _handleInvalidMessage(data) {
    const error = new Error('The payload received is not a valid JSON:\n' + data);
    return this._handleActionError(error, {});
  }

  _handleAction(action) {
    this._assertActionHasType(action);

    switch (action.type) {
      case 'login':
        return this._handleLoginAction(action);
      default:
        this._assertActiveSession(action);
        this._session.carry(this, action);
    }
  }

  _handleActionError(error, action) {
    if (this._session && this._role === 'tester') {
      this.sendAction({
        type: 'error',
        error: error.message,
        messageId: action.messageId
      });
    } else {
      log.warn({ event: 'MESSAGE_ERROR', err: error }, `${error}`);
    }
  }

  _handleLoginAction(action) {
    if (!action.params) {
      throw new Error(`Invalid login action received, it has no .params:\n${J(action)}`);
    }

    if (!['app', 'tester'].includes(action.params.role)) {
      throw new Error(`Invalid login action received, it has invalid .role:\n${J(action)}`);
    }

    if (!action.params.sessionId) {
      throw new Error(`Invalid login action received, it has no sessionId:\n${J(action)}`);
    }

    if (typeof action.params.sessionId !== 'string') {
      throw new Error(`Invalid login action received, it has a non-string sessionId:\n${J(action)}`);
    }

    this._sessionManager.registerSession(this, action.params);
  }

  _assertActionHasType(action) {
    if (!action.type) {
      throw new Error(`Invalid action received, it has no type, cannot process:\n${J(action)}`);
    }
  }

  _assertActiveSession(action) {
    if (!this._session) {
      throw new Error(`Action dispatched too early, there is no session to use:\n${J(action)}`);
    }
  }
}

module.exports = DetoxConnection;