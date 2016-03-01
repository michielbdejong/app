/* global Request, Headers */

'use strict';

import { Service } from 'components/fxos-mvc/dist/mvc';

import FoxboxSettings from './foxbox-settings';
import FoxboxDb from './foxbox-db';
import FoxboxQr from './foxbox-qr';

// The delay after which a request is considered failed.
const REQUEST_TIMEOUT = 5000;

/**
 * Request a JSON from a specified URL.
 *
 * @param {string} url The URL to send the request to.
 * @param {string} method The HTTP method (defaults to "GET").
 * @param {Object} body An object of key/value.
 * @return {Promise}
 */
const loadJSON = function(url, method = 'GET', body = undefined) {
  method = method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    body = undefined;
  }

  let req = new Request(url, {
    method,
    headers: new Headers({
      'Accept': 'application/json'
    }),
    cache: 'no-store',
    body: JSON.stringify(body)
  });

  // Workaround to catch network failures.
  return new Promise((resolve, reject) => {
    let hasTimedOut = false;
    const timeout = setTimeout(() => {
      hasTimedOut = true;
      reject(new TypeError('Request timed out'));
    }, REQUEST_TIMEOUT);

    fetch(req)
      .then(res => {
        if (hasTimedOut) {
          return;
        }

        clearTimeout(timeout);

        if (res.ok) {
          return resolve(res.json());
        } else {
          throw new TypeError(`The response returned a ${res.status} HTTP status code.`);
        }
      });
  });
};

export default class Foxbox extends Service {
  constructor() {
    super();
    this.settings = new FoxboxSettings();
    this.db = new FoxboxDb();
    this.qr = new FoxboxQr();
  }

  init() {
    return this.db.init();
  }

  get origin() {
    return `${this.settings.scheme}://${this.settings.hostname}:${this.settings.port}`;
  }

  /**
   * Retrieve the list of the services available.
   *
   * @return {Promise} A promise that resolves with an array of objects.
   */
  getServices() {
    return new Promise((resolve, reject) => {
      loadJSON(`${this.origin}/services/list.json`)
        .then(services => {
          // Let's remove the dummy services here.
          services = services.filter(service => service.name !== 'dummy service');

          const promises =
            services.map(service => loadJSON(`http://localhost:3000/services/${service.id}/state`, 'GET'));
          Promise.all(promises)
            .then(states => {
              services.forEach((service, id) => service.state = states[id]);

              // Clear the services db.
              this.db.clearServices()
                .then(() => {
                  // Populate the db with the latest services.
                  services.forEach(service => {
                    this.db.setService(service);
                  });
                });

              return resolve(services);
            });
        });
    });
  }

  /**
   * Change the state of a service.
   *
   * @param {string} id The ID of the service.
   * @param {Object} state An object containing pairs of key/value.
   * @return {Promise}
   */
  changeServiceState(id, state) {
    return new Promise((resolve, reject) => {
      loadJSON(`${this.origin}/services/${id}/state`, 'PUT', state)
        .then(res => {
          if (!res || !res.result || res.result !== 'success') {
            return reject(new Error(`The action couldn't be performed.`));
          }

          return resolve();
        });
    });
  }

  getTags() {
    return this.db.getTags.apply(this.db, arguments);
  }

  getService() {
    // Get data from the DB so we get the attributes, the state and the tags.
    return this.db.getService.apply(this.db, arguments);
  }

  setService() {
    return this.db.setService.apply(this.db, arguments);
  }

  setTag() {
    return this.db.setTag.apply(this.db, arguments);
  }
}
