const _ = require('lodash');
const express = require('express');
const orid = require('@maddonkeysoftware/orid-node');

const repos = require('../repos');
const globals = require('../globals');
const handlerHelpers = require('./handler-helpers');
const resourceInvoker = require('./resource_invoker');

const router = express.Router();

const oridBase = {
  provider: handlerHelpers.getIssuer(),
  service: 'qs',
};

const makeOrid = (name, accountId) => orid.v1.generate(_.merge({}, oridBase, {
  resourceId: name,
  custom3: accountId,
}));

const oridToRepoName = (inOrid) => inOrid.replace(/:/g, '_');
const repoNameToOrid = (inName) => inName.replace(/_/g, ':');

const listQueues = (request, response) => {
  const accountId = _.get(request, ['parsedToken', 'payload', 'accountId']);
  return repos.listQueues()
    .then((results) => results.map((e) => {
      const parsedOrid = orid.v1.parse(repoNameToOrid(e));
      return parsedOrid.custom3 !== accountId
        ? undefined
        : ({
          name: parsedOrid.resourceId,
          orid: repoNameToOrid(e),
        });
    }))
    .then((results) => _.filter(results, (e) => !!e))
    .then((result) => handlerHelpers.sendResponse(response, 200, JSON.stringify(result)));
};

const queueExists = (newName, queues) => queues.indexOf(newName) > -1;

const createQueue = (request, response) => {
  const logger = globals.getLogger();
  const {
    resource, name, maxSize, delay, vt,
  } = request.body;
  const queueMeta = JSON.stringify({
    resource,
  });
  const accountId = _.get(request, ['parsedToken', 'payload', 'accountId']);

  const nameRegex = /^[a-zA-Z0-9-]*$/;
  if (!nameRegex.test(name) || name.length > 50) {
    handlerHelpers.sendResponse(response, 400, JSON.stringify({
      message: 'Queue name invalid. Criteria: maximum length 50 characters, alphanumeric and hyphen only allowed.',
    }));
    return Promise.resolve();
  }

  const newOrid = makeOrid(name, accountId);
  const escapedName = oridToRepoName(newOrid);

  const newQueue = (newName, size, mdelay, visTimeout) => (
    repos.createQueue(newName, size, mdelay, visTimeout)
      .then(() => repos.setValueForKey(`queue-meta:${newName}`, queueMeta))
      .then(() => true));

  const respObj = {
    name,
    orid: newOrid,
  };

  return repos.listQueues()
    .then((queues) => queueExists(escapedName, queues))
    .then((exists) => !exists && newQueue(escapedName, maxSize, delay, vt))
    .then((created) => handlerHelpers.sendResponse(response,
      created ? 201 : 200,
      JSON.stringify(respObj)))
    .catch((err) => {
      logger.error({ err }, 'Failed to create queue.');
      handlerHelpers.sendResponse(response, 500);
    });
};

const updateQueue = (request, response) => {
  const { body } = request;
  const { resource } = body;
  const reqOrid = handlerHelpers.getOridFromRequest(request, 'orid');
  const escapedName = oridToRepoName(orid.v1.generate(reqOrid));

  const mergeWithFilter = (a, b) => (b === undefined ? a : undefined);
  const metaKey = `queue-meta:${escapedName}`;
  return repos.getValueForKey(metaKey)
    .then((currentMeta) => JSON.parse(currentMeta))
    .then((currentMeta) => _.mergeWith({}, currentMeta, { resource }, mergeWithFilter))
    .then((newMeta) => _.pickBy(newMeta, _.identity))
    .then((newMeta) => repos.setValueForKey(metaKey, JSON.stringify(newMeta)))
    .then(() => handlerHelpers.sendResponse(response));
};

const removeQueue = (request, response) => {
  const reqOrid = handlerHelpers.getOridFromRequest(request, 'orid');
  const escapedName = oridToRepoName(orid.v1.generate(reqOrid));

  const deleteQueue = () => repos.removeQueue(escapedName)
    .then(() => repos.removeKey(`queue-meta:${escapedName}`));

  return repos.listQueues()
    .then((queues) => queueExists(escapedName, queues))
    .then((exists) => exists && deleteQueue())
    .then((deleted) => handlerHelpers.sendResponse(response, deleted ? 204 : 404));
};

const getQueueDetails = (request, response) => {
  const reqOrid = handlerHelpers.getOridFromRequest(request, 'orid');
  const queueOrid = orid.v1.generate(reqOrid);
  const escapedName = oridToRepoName(queueOrid);

  return repos.getValueForKey(`queue-meta:${escapedName}`)
    .then((metadata) => metadata || '{}')
    .then((metadata) => {
      const meta = JSON.parse(metadata);
      return JSON.stringify(_.merge(
        {},
        meta,
        { orid: queueOrid },
      ));
    })
    .then((metadata) => handlerHelpers.sendResponse(response, 200, metadata));
};

const getMessageCount = (request, response) => {
  const reqOrid = handlerHelpers.getOridFromRequest(request, 'orid');
  const queueOrid = orid.v1.generate(reqOrid);
  const escapedName = oridToRepoName(queueOrid);

  return repos.getQueueSize(escapedName)
    .then((size) => handlerHelpers.sendResponse(response, 200, JSON.stringify({
      size,
      orid: queueOrid,
    })))
    .catch(() => handlerHelpers.sendResponse(response, 404));
};

const getMessage = (request, response) => {
  const logger = globals.getLogger();

  const reqOrid = handlerHelpers.getOridFromRequest(request, 'orid');
  const escapedName = oridToRepoName(orid.v1.generate(reqOrid));

  return repos.getMessage(escapedName)
    .then((message) => handlerHelpers.sendResponse(response, 200, message))
    .catch((err) => {
      if (err.name === 'queueNotFound') {
        handlerHelpers.sendResponse(response, 404);
        return;
      }

      logger.warn({ err }, 'Error occurred while attempting to get queue message.');
      handlerHelpers.sendResponse(response, 500);
    });
};

const createMessage = (request, response) => {
  const { body } = request;
  const message = JSON.stringify(body);

  const reqOrid = handlerHelpers.getOridFromRequest(request, 'orid');
  const escapedName = oridToRepoName(orid.v1.generate(reqOrid));

  // TODO: Research if resource defined skip queue and invoke directly is option
  // May want to also entertain batching messages before sending them to defined
  // resource or incrementally invoking the resource with message batches while
  // the queue is above zero messages.
  return repos.createMessage(escapedName, message)
    .then(() => { resourceInvoker.invokeResourceUntilEmpty(escapedName); })
    .then(() => handlerHelpers.sendResponse(response));
};

const removeMessage = (request, response) => {
  const { params } = request;
  const logger = globals.getLogger();

  const reqOrid = handlerHelpers.getOridFromRequest(request, 'orid');
  const escapedName = oridToRepoName(orid.v1.generate(_.omit(reqOrid, 'resourceRider')));

  return repos.removeMessage(escapedName, reqOrid.resourceRider)
    .then((count) => handlerHelpers.sendResponse(response, count ? 200 : 404))
    .catch((err) => {
      logger.error({ err, params }, 'Message remove failed');
    });
};

const logger = globals.getLogger();
router.get('/queues', handlerHelpers.validateToken(logger), listQueues); // get list of queues
router.post('/queue', handlerHelpers.validateToken(logger), createQueue); // create new queue
router.post('/queue/:orid',
  handlerHelpers.validateToken(logger),
  handlerHelpers.ensureRequestOrid(false, 'orid'),
  handlerHelpers.canAccessResource({ oridKey: 'orid', logger }),
  updateQueue); // update a queue
router.delete('/queue/:orid',
  handlerHelpers.validateToken(logger),
  handlerHelpers.ensureRequestOrid(false, 'orid'),
  handlerHelpers.canAccessResource({ oridKey: 'orid', logger }),
  removeQueue); // deletes a queue from the system
router.get('/queue/:orid/details',
  handlerHelpers.validateToken(logger),
  handlerHelpers.ensureRequestOrid(false, 'orid'),
  handlerHelpers.canAccessResource({ oridKey: 'orid', logger }),
  getQueueDetails); // gets the metadata associated with the queue
router.get('/queue/:orid/length',
  handlerHelpers.validateToken(logger),
  handlerHelpers.ensureRequestOrid(false, 'orid'),
  handlerHelpers.canAccessResource({ oridKey: 'orid', logger }),
  getMessageCount); // get the count of messages in a queue
router.get('/message/:orid',
  handlerHelpers.validateToken(logger),
  handlerHelpers.ensureRequestOrid(false, 'orid'),
  handlerHelpers.canAccessResource({ oridKey: 'orid', logger }),
  getMessage); // get a message from the queue
router.post('/message/:orid',
  handlerHelpers.validateToken(logger),
  handlerHelpers.ensureRequestOrid(false, 'orid'),
  handlerHelpers.canAccessResource({ oridKey: 'orid', logger }),
  createMessage); // send a message to the queue
router.delete('/message/:orid*',
  handlerHelpers.validateToken(logger),
  handlerHelpers.ensureRequestOrid(true, 'orid'),
  handlerHelpers.canAccessResource({ oridKey: 'orid', logger }),
  removeMessage); // deletes a message from the system

module.exports = router;
