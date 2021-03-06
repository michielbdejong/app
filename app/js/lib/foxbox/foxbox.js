/* global URLSearchParams */

'use strict';

import { Service } from 'components/mvc';

import Settings from './settings';
import Db from './db';
import Network from './network';
import Recipes from './recipes';

// Private members.
const p = Object.freeze({
  // Private properties.
  settings: Symbol('settings'),
  db: Symbol('db'),
  net: Symbol('net'),
  boxes: Symbol('boxes'),
  isPollingEnabled: Symbol('isPollingEnabled'),
  nextPollTimeout: Symbol('nextPollTimeout'),

  // Private methods.
  fetchServices: Symbol('fetchServices'),
  getOperationValueType: Symbol('getOperationValueType')
});

/**
 * Compare 2 objects. Returns true if all properties of object A have the same
 * value in object B. Extraneous properties in object B are ignored.
 * Properties order is not important.
 *
 * @param {Object} objectA
 * @param {Object} objectB
 * @return {boolean}
 */
const isSimilar = (objectA, objectB) => {
  for (let prop in objectA) {
    if (!(prop in objectB) || objectA[prop] !== objectB[prop]) {
      return false;
    }
  }

  return true;
};

export default class Foxbox extends Service {
  constructor() {
    super();

    // Private properties.
    this[p.settings] = new Settings();
    this[p.db] = new Db();
    this[p.net] = new Network(this[p.settings]);
    this[p.boxes] = Object.freeze([]);
    this[p.isPollingEnabled] = false;
    this[p.nextPollTimeout] = null;

    // Public properties.
    this.recipes = null;

    Object.seal(this);
  }

  init() {
    window.foxbox = this;

    return this._initUserSession()
      .then(() => {
        return this._initDiscovery();
      })
      .then(() => {
        return this[p.net].init();
      })
      .then(() => {
        // The DB is only initialised if there's no redirection to the box.
        return this[p.db].init();
      })
      .then(() => {
        // Start polling.
        this[p.settings].on('pollingEnabled', () => {
          this.togglePolling(this[p.settings].pollingEnabled);
        });
        this.togglePolling(this[p.settings].pollingEnabled);

        this.recipes = new Recipes({
          settings: this[p.settings],
          net: this[p.net]
        });
      });
  }

  /**
   * Clear all data/settings stored on the browser. Use with caution.
   */
  clear() {
    const promises = [this[p.settings].clear(), this[p.db].clear()];
    return Promise.all(promises);
  }

  get localHostname() {
    return this[p.settings].localHostname;
  }

  get boxes() {
    return this[p.boxes];
  }

  /**
   * Get the IP address of the box on the local network using mDNS.
   * If it fails, we fallback to the previously set hostname.
   * It there isn't, it falls back to localhost.
   *
   * @returns {Promise}
   * @private
   */
  _initDiscovery() {
    console.log('init discovery!');
    // For development purposes if you want to skip the
    // discovery phase set the 'foxbox-skipDiscovery' variable to
    // 'true'.
    if (this[p.settings].skipDiscovery) {
      return Promise.resolve();
    }
    window.cordova.plugins.zeroconf.watch('_https._tcp.local.', result => {
      console.log('service found!', result);
      const action = result.action;
      const service = result.service;
      if (action == 'added') {
        this[p.boxes].push(service);
        this.selectBox();
      }
    });
    return Promise.resolve();
  }

  /**
   * Change the currently selected box.
   *
   * @param {number} index The index of the box in the boxes array.
   */
  selectBox(index = 0) {
    if (index >= this[p.boxes].length) {
      this[p.settings].configured = false;
      console.error('Index out of range.');

      return;
    }

    const box = this[p.boxes][index];
    console.log('selecting box', box);
    this[p.settings].url = `https://${box.txtRecord.name}:${box.port}`;
    this[p.settings].ipaddrs = box.addresses;
    window.cordovaHTTP.setProxyHost(box.addresses[0], function() {
      window.cordovaHTTP.setProxyPort(box.port, function() {
        this[p.settings].configured = true;
      });
    });
  }

  /**
   * Detect a session token in the URL and process it if present.
   *
   * @return {Promise}
   * @private
   */
  _initUserSession() {
    if (this.isLoggedIn) {
      return Promise.resolve();
    }

    const queryStringParts = location.search.substring(1).split('&');
    for(let i=0; i<queryStringParts.length; i++) {
      if (queryStringParts[i].substring(0, 'session_token='.length) ===
          'session_token') {
        // There is a session token in the URL, let's remember it.
        // @todo Find a better way to handle URL escape.
        this[p.settings].session = queryStringParts[i].substring(0,
            'session_token='.length)
          .replace(/ /g, '+');

        // Remove the session param from the current location.
        queryStringParts.splice(i, 1);
        location.search = queryStringParts.join('&');

        // Throwing here to abort the promise chain.
        throw(new Error('Redirecting to a URL without session'));
      }
    }

    return Promise.resolve();
  }

  get isLoggedIn() {
    return !!this[p.settings].session;
  }

  /**
   * Redirect the user to the box to get authenticated if she isn't already.
   */
  login() {
    if (this.isLoggedIn) {
      return;
    }

    const redirectUrl = encodeURIComponent(location);
    location.replace(`${this[p.net].origin}/?redirect_url=${redirectUrl}`);
  }

  /**
   * Log out the user.
   */
  logout() {
    this[p.settings].session = undefined;
  }

  /**
   * Start or stop polling.
   *
   * @param {boolean} pollingEnabled Flag that indicates whether polling should
   * be started or stopped.
   */
  togglePolling(pollingEnabled) {
    this[p.isPollingEnabled] = pollingEnabled;

    if (pollingEnabled) {
      this.schedulePoll();
    } else {
      // Cancel next poll attempt if it has been scheduled.
      clearTimeout(this[p.nextPollTimeout]);
      this[p.nextPollTimeout] = null;
    }
  }

  /**
   * Schedules an attempt to poll the server, does nothing if polling is not
   * enabled or it has already been scheduled. New poll is scheduled only once
   * previous one is completed or failed.
   */
  schedulePoll() {
    // Return early if polling is not enabled or it has already been scheduled.
    if (!this[p.isPollingEnabled] ||
      this[p.nextPollTimeout]) {
      return;
    }

    this[p.nextPollTimeout] = setTimeout(() => {
      this.refreshServicesByPolling()
        .catch((e) => {
          console.error('Polling has failed, scheduling one more attempt: ', e);
        })
        .then(() => {
          this[p.nextPollTimeout] = null;

          this.schedulePoll();
        });
    }, this[p.settings].pollingInterval);
  }

  /**
   * Detect changes in the services:
   * * Emits a `service-change` event if a service is connected/disconnected.
   * * Emits a `service-state-change` event if the state of a service changes.
   *
   * @return {Promise}
   */
  refreshServicesByPolling() {
    if (!this.isLoggedIn) {
      return Promise.resolve();
    }

    /*const fetchedServicesPromise = this[p.net]
      .fetchJSON(`${this[p.net].origin}/services/list`)
      .then((services) => {
        // @todo We should ask for state only for services that actually support
        // it.
        return Promise.all(
          services.map((service) => {
            // Use empty state if service failed to return actual state.
            return this.getServiceState(service.id)
              .catch(() => ({}))
              .then((state) => service.state = state);
          })
        ).then(() => services);
      });*/

    return Promise.all([this.getServices(), this[p.fetchServices]()])
      .then(([storedServices, fetchedServices]) => {
        let hasNewServices = fetchedServices.reduce(
          (hasNewServices, fetchedService) => {
            const storedService = storedServices.find(
              s => s.id === fetchedService.id
            );

            const isExistingService = !!storedService;

            if (isExistingService &&
              isSimilar(fetchedService.state, storedService.state)) {
              return hasNewServices;
            }

            fetchedService = isExistingService ?
              Object.assign(storedService, fetchedService) : fetchedService;

            this._dispatchEvent('service-state-change', fetchedService);

            // Populate the db with the latest service.
            this[p.db].setService(fetchedService);

            return hasNewServices || !isExistingService;
          },
          false /* hasNewServices */
        );

        if (hasNewServices ||
          fetchedServices.length !== storedServices.length) {
          // The state of the services changes.
          this._dispatchEvent('service-change', fetchedServices);
        }

        return fetchedServices;
      });
  }

  /**
   * Retrieve the list of the services available.
   * Use the database as a source of truth.
   *
   * @return {Promise} A promise that resolves with an array of objects.
   */
  getServices() {
    return this[p.db].getServices()
      .then(services => {
        return services.map(service => service.data);
      });
  }

  /**
   * Fetch the state of a service from the box.
   *
   * @param {string} id The ID of the service.
   * @return {Promise}
   */
  getServiceState(id) {
    return this[p.net].fetchJSON(`${this[p.net].origin}/services/${id}/state`)
      .then(res => {
        if (!res) {
          throw new Error('The action couldn\'t be performed.');
        }

        return res;
      });
  }

  /**
   * Change the state of a service.
   *
   * @param {string} id The ID of the service.
   * @param {Object} state An object containing pairs of key/value.
   * @return {Promise}
   */
  setServiceState(id, state) {
    return new Promise((resolve, reject) => {
      this[p.net].fetchJSON(`${this[p.net].origin}/services/${id}/state`,
        'PUT', state)
        .then(res => {
          if (!res || !res.result || res.result !== 'success') {
            return reject(new Error('The action couldn\'t be performed.'));
          }

          return resolve();
        });
    });
  }

  getTags() {
    return this[p.db].getTags.apply(this[p.db], arguments);
  }

  getService() {
    // Get data from the DB so we get the attributes, the state and the tags.
    return this[p.db].getService.apply(this[p.db], arguments);
  }

  setService() {
    return this[p.db].setService.apply(this[p.db], arguments);
  }

  setTag() {
    return this[p.db].setTag.apply(this[p.db], arguments);
  }

  performSetOperation(operation, value) {
    let operationType = this[p.getOperationValueType](operation.kind);
    return this[p.net].fetchJSON(
      `${this[p.net].origin}/api/v${this[p.settings].apiVersion}/channels/set`,
      'PUT',
      // Query operation by id.
      [[{ id: operation.id }, { [operationType]: value }]]
    );
  }

  performGetOperation(operation) {
    let payload = { id: operation.id };

    if (operation.kind.typ === 'Binary') {
      return this[p.net].fetchBlob(
        `${this[p.net].origin}/api/v${this[p.settings].apiVersion}` +
        '/channels/get',
        // For now we only support JPEG blobs.
        'image/jpeg',
        'PUT',
        payload
      );
    }

    return this[p.net].fetchJSON(
      `${this[p.net].origin}/api/v${this[p.settings].apiVersion}/channels/get`,
      'PUT',
      payload
    );
  }

  [p.fetchServices]() {
    return this[p.net].fetchJSON(
      `${this[p.net].origin}/api/v${this[p.settings].apiVersion}/services`)
      .then((services) => {
        return services.map((service) => {
          return {
            id: service.id,
            type: service.adapter,
            getters: service.getters,
            setters: service.setters,
            properties: service.properties
          };
        });
      });
  }

  /**
   * Returns value type string for the specified operation kind.
   *
   * @param {string|Object} operationKind Kind of the operation, string for the
   * well known type and object for the Extension channel kind.
   * @return {string}
   * @private
   */
  [p.getOperationValueType](operationKind) {
    if (!operationKind) {
      throw new Error('Operation kind is not defined!');
    }

    // Operation kind can be either object or string.
    if (typeof operationKind === 'object') {
      return operationKind.typ;
    }

    switch (operationKind) {
      case 'TakeSnapshot':
        return 'Unit';
      default:
        return operationKind;
    }
  }
}
