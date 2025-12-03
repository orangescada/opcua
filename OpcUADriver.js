'use strict'

//*****************************************************************
// This module implements features of OPCUA driver
//*****************************************************************

const {
  OPCUAClient,
  MessageSecurityMode,
  SecurityPolicy,
  AttributeIds,
  TimestampsToReturn,
  StatusCodes,
  DataType,
  UserTokenType,
  NodeClass
} = require("node-opcua-client");
const moment = require("moment/moment");

// Error text constants

const errDeviceIdNotFoundTxt    = 'Device ID not found';
const errTagNotFoundTxt         = 'Tag not found';
const errTagNotWriteableTxt     = 'Tag not writeable';
const errConfigTxt              = 'Config error';
const errHostCloseConnectTxt    = 'Host close connection';
const errSubscriptionTxt        = 'Subscription terminated';
const errOpcReject              = 'Opcua server reject connection';
const errEmptySession           = 'Empty session';
const errWriteFail              = 'Write fail';
const restartOnChangeTxt        = 'Restart on change params';


// default parameters constants

const defaultTimeout            = 10000;
const dateTimeFormat            = 'DD.MM.YYYY HH:mm:ss';
const maxStringSize             = 16;
const sendProgressTimeout       = 1000;

// class implements OPCUA driver
class CustomDriver{
  /**
   *  Class constructor
   *  @param {object} deviceList - list of devices and nodes
   *  @param {method} subscribeHandler - handler calling then subscribed value changes
   */
  constructor(deviceList, subscribeHandler, progressHandler, logger){
    this.deviceList = deviceList;
    this.connections = {};
    this.subscribeHandler = subscribeHandler;
    this.progressHandler = progressHandler;
    this.logger = logger;
    this.browserFlag = false;
    this.browserCount = 0;
    this.progressId = 0;
  }

  // returns device status {active: true | false}
  getDeviceStatus(dataObj){
    let device = this.deviceList.list ? this.deviceList.list[dataObj.uid] : null;
    if(!device) return {active: false};
    const deviceUid = dataObj.uid;
    dataObj.deviceUid = deviceUid;
    let firstTag = device.tags ? Object.keys(device.tags)[0] : undefined;
    dataObj.tags = firstTag ? [firstTag] : [];
    let fullDeviceName = this.getFullDeviceAddress(dataObj.uid);
    if(!this.connections[fullDeviceName] || !this.connections[fullDeviceName][deviceUid]){
      this.getTagsList('read', dataObj)
        .then(tags => this.createConnect(tags, dataObj.uid))
        .catch( _ => {});
      return {active: false};
    }
    return {active: this.connections[fullDeviceName][deviceUid].client.connected};
  }

  /**
   * getTagsValues - implements tags values getter
   * @param {object} dataObj - object contains tags for getting value
   *        dataObj.cmd = getTagsValues
   *        dataObj.deviceUid = device Id
   *        dataObj.tags = array of tag names
   * @returns {Promise} Promise with result of tag getting request
   *          if resolve it returns object:
   *            res.answer.cmd = getTagsValues
   *            res.answer.transID = transaction ID (equal to request)
   *            res.answer.values = array with tag values (request order)
   *            res.answer.err = ""
   *          if reject it returns object
   *            res.answer.err = error message
   */ 
  getTagsValues(dataObj){
    return new Promise((resolve, reject) => {
      let res = {};
      res.answer = {cmd:dataObj.cmd, transID: dataObj.transID};
      this.getTagsList('read', dataObj)
      .then(tags => this.opcuaReadRequest(tags, dataObj.deviceUid))
      .then(values => {
        res.answer.values = values;
        res.error = "";
        resolve(res);
      })
      .catch(err => {
        res.error = err;
        reject(res);
      })
  	})
  }

  /**
   * setTagsValues - implements tags values setter
   * @param {object} dataObj - object contains tags for setting value
   *                           dataObj.cmd = setTagsValues
   *                           dataObj.deviceUid = device Id
   *                           dataObj.tags = array of objects {tagName : setValue} 
   * @returns {Promise} Promise with result of tag setting request
   *                    if resolve it returns object:
   *                    res.answer.cmd = setTagsValues
   *                    res.answer.transID = transaction ID (equal to request)
   *                    res.answer.err = ""
   *                    if reject it returns object
   *                    res.answer.err = error message
   */
  setTagsValues(dataObj){
    return new Promise((resolve, reject) => {
      let res = {};
      res.answer = {cmd:dataObj.cmd, transID: dataObj.transID};
      this.getTagsList('write', dataObj)
      .then(tags => this.opcuaWriteRequest(tags, dataObj.deviceUid))
      .then( _ => {
        res.error = "";
        resolve(res);
      })
      .catch(err => {
        res.error = err;
        reject(res);
      })
    })
  }

  // restart opc connection on change tags or connections params
  restartDevice(dataObj) {
    const deviceId = dataObj.cmd === 'setTag' ? dataObj.deviceUid : dataObj.uid;
    const fullDeviceName = this.getFullDeviceAddress(deviceId);
    if(fullDeviceName){
      const client = this.connections[fullDeviceName] ? this.connections[fullDeviceName][deviceId]?.client : undefined;
      try {
        if(client) this.destroyConnect(client, restartOnChangeTxt, () => {}, deviceId);
      }
      catch (err) {
        this.logger(err)
      }
    }
  }

  /**
   * sendProgress - this method must be implements if driver can abserve tags
   * @param {object} dataObj - object contains device for tags update
   * @returns {boolean} true if config has updated, otherwise false
   */
  sendProgress(dataObj) {
    dataObj.progressTxt = `Tag browsing in progress: ${this.browserCount}`;
    dataObj.progressId = this.progressId;
    dataObj.done = !this.browserFlag;
    this.progressHandler(dataObj)
    if (this.browserFlag) {
      setTimeout(() => this.sendProgress(dataObj), sendProgressTimeout);
    }
  }

  /**
   * updateTagListFromDevice - this method must be implements if driver can abserve tags
   * @param {object} dataObj - object contains device for tags update
   * @returns {boolean} true if config has updated, otherwise false
   */
  updateTagListFromDevice(dataObj, setConfigHandler){
    return new Promise(resolve => {
      const fullDeviceName = this.getFullDeviceAddress(dataObj.deviceUid);
      if(this.deviceList.list[dataObj.deviceUid]?.options.browseTrigger?.currentValue !== "Start") {
        resolve();
        return;
      }
      if(!fullDeviceName) {
        resolve();
        return;
      }

      const session = this.connections[fullDeviceName] ? this.connections[fullDeviceName][dataObj.deviceUid]?.session : undefined;
      if (!this.browserFlag) {
        this.browserCount = 0
        this.browserFlag = true
        this.progressId++
        this.sendProgress(dataObj)
        const createConnectPromise = session ? Promise.resolve() : this.createConnect([], dataObj.deviceUid)
  
        createConnectPromise
        .then( _ => {
          return this.browseTagsIter(this.connections[fullDeviceName][dataObj.deviceUid]?.session)
        })
        .then(browseTags => this.populateDevice(dataObj, browseTags))
        .then( _ => {
          this.browserFlag = false
          setConfigHandler()
          resolve()
        })
        .catch( _ => {
          this.browserFlag = false
          resolve()
        })
      }

      if (this.browserFlag) {
        resolve({progressTxt: `Tag browsing in progress: ${this.browserCount}`, progressId: this.progressId})
        return
      }
    })
  }

  // map opc type to Orangescada tag type
  getTagType(nodeType) {
    switch(nodeType){
      case DataType.Null: 
      case DataType.String: 
        return 'string';
      case DataType.Boolean:
        return 'bool';
      case DataType.SByte:
      case DataType.Byte:
      case DataType.Int16:
      case DataType.UInt16:
      case DataType.Int32:
      case DataType.UInt32:
      case DataType.Int64:
      case DataType.UInt64:
        return 'int';
      case DataType.Float:
      case DataType.Double:
        return 'float';
      case DataType.DateTime:
        return 'datetime';
      default: 
        return 'string';
    }
  }

  // fill driver config with browsed opc tags, reset browse trigger to Stop
  populateDevice(dataObj, browseTags) {
    let device = this.deviceList.list ? this.deviceList.list[dataObj.deviceUid] : null;
    if(device) {
      const tagmap = [];
      let maxTagId = 0;
      if(browseTags) {
        if(!device.tags) {
          device.tags = {};
        }
        Object.keys(device.tags).forEach(tag => {
          tagmap.push([tag, device.tags[tag].name]);
          const tagId = parseInt(tag);
          if(tagId > maxTagId) maxTagId = tagId;
        })
        browseTags.forEach(browseTag => {
          const idx = tagmap.findIndex(tag => tag[1] === browseTag.name);
          let tagUid = idx >= 0 ? tagmap[idx][0] : ''
          if(!tagUid){
            tagUid = ++maxTagId;
            device.tags[tagUid] = {};
            device.tags[tagUid].name = browseTag.name;
            device.tags[tagUid].options = {
              nodeId: {currentValue: ""},
              nodeType: {currentValue: browseTag.type},
              arrayIndex: {currentValue: browseTag.arrayIndex}
            };
            device.tags[tagUid].address = tagUid;
            device.tags[tagUid].read = true;
            device.tags[tagUid].write = true;
          }
          device.tags[tagUid].options.nodeId.currentValue = browseTag.nodeId;
          device.tags[tagUid].options.nodeType.currentValue = browseTag.type;
          device.tags[tagUid].options.arrayIndex.currentValue = browseTag.arrayIndex;
          device.tags[tagUid].type = this.getTagType(browseTag.type);
          if (idx >= 0) tagmap[idx][0] = ''
        })
      }
      device.options.browseTrigger.currentValue = "Stop";
      tagmap.forEach(tag => {
        if (tag[0] !== '') delete device.tags[tag[0]];
      })
    }
  }

  // get opc node id
  getNodeId(nodeId) {
    let res = "";
    if(nodeId.namespace) res = `ns=${nodeId.namespace};`;
    if(nodeId.identifierType > 0) {
      const nodeType = ["i","s","g","b"][nodeId.identifierType - 1];
      res += `${nodeType}=${nodeId.value}`;
    }
    return res;
  }

  // one level iteration of opc tags search, run in recursion
  browseTagsIter(session, nodeToBrowse = "RootFolder", folder = "", browseTags = []) {
    return new Promise(resolve => {
      let chain = Promise.resolve();
      chain = chain.then( _ => {
        return new Promise(resolve => {
          if (!session) {
            resolve(null);
            return;
          }
          session.browse(nodeToBrowse)
          .then(browseResult => resolve(browseResult))
          .catch(err => {
            this.logger("browse error=", err)
            resolve(null);
          })
        })
      })
      chain = chain.then(browseResult => {
        if(browseResult) {
          browseResult.references.forEach(ref => {
            const slashFolder = folder ? `${folder}/` : ""
            if(ref.nodeClass === NodeClass.Variable || ref.nodeClass === NodeClass.Object) { 
              chain = chain.then( _ => {
                return session.read({nodeId: ref.nodeId})
              })
              .then(data => {
                const isArray = data?.value?.arrayType === 1;
                const arraySize = data?.value?.value ? data?.value?.value.toString().split(',').length : 1;
                const tagsCount = isArray ? arraySize : 1;
                this.browserCount++;
                for (let i = 0; i < tagsCount; i++) {
                  browseTags.push({
                    "name": `${slashFolder}${ref.displayName.text}/_value${isArray ? `[${i}]` : ''}`,
                    "nodeId": this.getNodeId(ref.nodeId),
                    "type": data?.value?.dataType ?? 0,
                    "arrayIndex": isArray ? i : -1
                  });
                }
              })
              .catch(err => this.logger)
            }
            chain = chain.then( _ => this.browseTagsIter(session, ref.nodeId, `${slashFolder}${ref.displayName.text}`, browseTags))
          })
        }
        chain = chain.then( _ => resolve(browseTags));
      })
    })
  }

  /**
   * updateSubscribe - method update this.subscribed object based on this.deviceList.list object
   */
  updateSubscribe(){
    for(let item in this.deviceList.list){
      let dataObj = {};
      dataObj.deviceUid = item;
      dataObj.tags = this.deviceList.list[item].tags ? Object.keys(this.deviceList.list[item].tags) : [];
      const tags = this.deviceTagsToArray('read', this.deviceList.list[item], dataObj, true);
      const fullDeviceName = this.deviceList.list[item].options.endpointUrl.currentValue;
      const tagNames = tags.map(tag => tag.name);
      dataObj.tags.forEach(tag => {
        if(this.connections[fullDeviceName] && this.connections[fullDeviceName][item]?.tags[tag]){
          this.connections[fullDeviceName][item].tags[tag].subscribed = tagNames.includes(tag)
        }
      })
      if(tags.length > 0){
        this.opcuaReadRequest(tags, item)
        .catch(err => this.logger(err))
      }
    }
  }


  /**
   * getTagsList - function returns array of tags objects with all necessary options for read or write tags values
   * @param {string} cmd - read|write
   * @param {object} dataObj - tags object
   * @returns {Promise} array of tags objects with options on success, error text on fail
   */
  getTagsList(cmd, dataObj){
    return new Promise((resolve, reject) => {
      let device = this.deviceList.list  ? this.deviceList.list[dataObj.deviceUid] : null;
      if(!device){
        reject(errDeviceIdNotFoundTxt);
        return;
      }
      const tags = this.deviceTagsToArray(cmd, device, dataObj);
      resolve(tags);
    });
  }

  // converts tags object to array, add tag params for next process
  deviceTagsToArray(cmd, device, dataObj, subscribeOnly = false) {
    let tags = [];
    for(let item of dataObj.tags){
      let tag = null;
      let tagName = null;
      let tagItem = {};

      if(cmd == 'read') tag = device.tags ? device.tags[item] : null;
      if(cmd == 'write'){
        tagName = Object.keys(item)[0];
        if(tagName !== null) tag = device.tags ? device.tags[tagName] : null;
      }
      if(!tag){
        tagItem.err = errTagNotFoundTxt;
      }else{
        if((cmd == 'write')  && !tag.write){
          tagItem.err = errTagNotWriteableTxt;
        }
      }

      if(subscribeOnly && !tag.subscribed) continue;
      
      try{
        tagItem.nodeId = tag.options.nodeId.currentValue;
        tagItem.nodeType = tag.options.nodeType?.currentValue ?? 0;
        tagItem.arrayIndex = tag.options.arrayIndex?.currentValue ?? -1;
        tagItem.endpointUrl = device.options.endpointUrl.currentValue;
        tagItem.deviceUid = dataObj.deviceUid;
        tagItem.type = tag.type;
        tagItem.subscribed = tag.subscribed;
        if(cmd == 'read'){
          tagItem.name = item;
          tagItem.read = tag.read;
        }
        if(cmd == 'write'){
          tagItem.name = tagName;
          tagItem.setValue = item[tagName];
        }
      }catch(e){
        if (!tagItem.err) tagItem.err = errConfigTxt;
      }
      tags.push(tagItem);
    }
    return tags;
  }

  // returns array with current tags values
  opcuaGetValues(tags, fullDeviceName, deviceUid) {
    const getValue = (tag) => {
      if(!tag) return null
      return tag.value ?? (tag.err ? {"errorTxt": tag.err} : null)
    }
    return new Promise(resolve => resolve(tags.reduce((acc, tag) => {
      return [...acc, getValue(this.connections[fullDeviceName] ? this.connections[fullDeviceName][deviceUid]?.tags[tag.name] : undefined)]
    }, [])))
  }

  // returns value or array (depends on set tag is a part of array or not) with set values
  getSetValue(tag, deviceId) {
    if(tag.arrayIndex < 0) return this.getOneSetValue(tag);
    const originalValue = this.connections[tag.endpointUrl][deviceId].ns[tag.nodeId].originalValue;
    const valArray = [...originalValue]
    valArray[tag.arrayIndex] = this.getOneSetValue(tag);
    return valArray;
  }

  // converts set value to tag type
  getOneSetValue(tag) {
    switch (tag.type) {
      case 'datetime': return moment.utc(tag.setValue, dateTimeFormat).toDate();
      case 'bool': return !!tag.setValue;
      default: return tag.setValue;
    }
  }

  // write set tags to opc
  opcuaSetValues(tags, fullDeviceName, deviceId) {
    return new Promise((resolve, reject) => {
      const session = this.connections[fullDeviceName] ? this.connections[fullDeviceName][deviceId]?.session : undefined;
      if(!session){
        reject(errEmptySession);
        return;
      }
      Promise.all(tags.map(tag => {
        return new Promise((resolve, reject) => {
          if(tag.err){
            reject(tag.err)
          }else{
            const newValue = this.getSetValue(tag, deviceId)
            session.write({
              nodeId: tag.nodeId,
              attributeId: AttributeIds.Value,
              value: {
                statusCode: StatusCodes.Good,
                sourceTimestamp: new Date(),
                value: {
                  dataType: tag.nodeType,
                  value: newValue
                }
              }
            })
            .then(code => {
              if (code === StatusCodes.Good){
                resolve();
              }else{
                reject(`${errWriteFail}, error=${code._description}`);
              }
            })
            .catch(_error => {
              reject(errWriteFail);
            })
          }
        })
      }))
      .then(() => resolve())
      .catch((err) => {
        reject(err);
        return;
      })
    })
  }

  /**
   * opcuaReadRequest - uplevel method for read request prepare, send requests and handling result
   * @param {object} tags - tags objects array with options for requests
   * @returns {Promise} array of values on success, error text on fail
   */
  opcuaReadRequest(tags, deviceUid){
    return this.opcuaRequest(tags, this.opcuaGetValues, deviceUid);
  }

  // checks unmonitored tags, add whem to subscribe
  checkIfTagsInMonitor(tags, fullDeviceName, deviceUid) {
    const noMonitoredTags = tags.filter(
      tag => !this.connections[fullDeviceName] || !this.connections[fullDeviceName][deviceUid].tags[tag.name]
    );
    if(noMonitoredTags.length > 0) {
      const subscription = this.connections[fullDeviceName] ? this.connections[fullDeviceName][deviceUid].subscription : undefined;
      this.addMonitoredTags(subscription, noMonitoredTags, fullDeviceName, deviceUid);
    }
  }

  /**
   * opcuaWriteRequest - uplevel method for write request prepare, send requests and handling result
   * @param {object} tags - tags objects array with options for requests
   * @returns {Promise} undefined on success, text error on fail
   */
  opcuaWriteRequest(tags, deviceId){
    return this.opcuaRequest(tags, this.opcuaSetValues, deviceId)
  }

  // common method for read/write tags values
  opcuaRequest(tags, handler, deviceUid) {
    return new Promise((resolve,reject) => {
      try{
        if (tags.length === 0){
          resolve([]);
          return;
        }
        let fullDeviceName = this.getFullDeviceAddress(deviceUid);
        if (!this.connections[fullDeviceName] || !this.connections[fullDeviceName][deviceUid]){
          this.createConnect(tags, deviceUid)
          .then(() => handler.call(this, tags, fullDeviceName, deviceUid))
          .then(res => resolve(res))
          .catch(err => reject(err))
        }else{
          this.checkIfTagsInMonitor(tags, fullDeviceName, deviceUid);
          handler.call(this, tags, fullDeviceName, deviceUid)
          .then(res => resolve(res))
          .catch(err => {
            reject(err)
          })
        }
      }catch(err){
        reject(err.message);
      }
    })
  }

  // method for close session
  closeSession(fullDeviceAddress, deviceUid) {
    return new Promise(resolve => {
      if(!this.connections[fullDeviceAddress] || !this.connections[fullDeviceAddress][deviceUid]?.session){
        resolve()
      }else{
        this.connections[fullDeviceAddress][deviceUid].session.close()
        .then(() => resolve())
      }
    })
  }

  // method for destroy connect with opc
  destroyConnect(client, errTxt, reject, deviceUid) {
    this.closeSession(client.fullDeviceAddress, deviceUid)
    .then(() => client.disconnect())
    .finally(() => {
      delete this.connections[client.fullDeviceAddress][deviceUid];
      this.connections[client.fullDeviceAddress][deviceUid] = null;
      client.connected = false;
      let errText = `${errTxt} ${client.fullDeviceAddress}`;
      if(reject) reject(errText);
    })
  }

  // get security mode for opc connection
  getSecurityMode(deviceUid) {
    const securityMode = this.getDeviceSecurityMode(deviceUid);
    switch(securityMode) {
      case 'Sign': return MessageSecurityMode.Sign;
      case 'SignAndEncrypt': return MessageSecurityMode.SignAndEncrypt;
      default: return MessageSecurityMode.None;
    }
  }

  // get security policy for opc connection
  getSecurityPolicy(deviceUid) {
    const securityPolicy = this.getDeviceSecurityPolicy(deviceUid);
    switch(securityPolicy) {
      case 'Aes128_Sha256_RsaOaep': return SecurityPolicy.Aes128_Sha256_RsaOaep;
      case 'Aes256_Sha256_RsaPss': return SecurityPolicy.Aes256_Sha256_RsaPss;
      case 'Basic128': return SecurityPolicy.Basic128;
      case 'Basic128Rsa15': return SecurityPolicy.Basic128Rsa15;
      case 'Basic192': return SecurityPolicy.Basic192;
      case 'Basic192Rsa15': return SecurityPolicy.Basic192Rsa15;
      case 'Basic256': return SecurityPolicy.Basic256;
      case 'Basic256Rsa15': return SecurityPolicy.Basic256Rsa15;
      case 'Basic256Sha256': return SecurityPolicy.Basic256Sha256;
      default: return SecurityPolicy.None;
    }
  }

  /**
   * createConnect - creates new opcua connect
   * initializes methods for events on.data, on.close, on.error
   * @param {object} tags - tags objects array with options for requests
   * @returns {Promise} resolve on success connect, reject on connect error
   */
  createConnect(tags, deviceUid){
    return new Promise((resolve, reject) => {
      const timeout = this.getTimeout(deviceUid) || defaultTimeout;
      const client = OPCUAClient.create({
        endpointMustExist: false,
        securityMode: this.getSecurityMode(deviceUid),
        securityPolicy: this.getSecurityPolicy(deviceUid),
        certificateFile: this.getCertificateFile(deviceUid),
        privateKeyFile: this.getPrivateKeyFile(deviceUid),
        connectionStrategy: {
            maxRetry: 1,
            initialDelay: 2000,
            maxDelay: timeout
        }
      });

      const fullDeviceName = this.getFullDeviceAddress(deviceUid);
      if (!this.connections[fullDeviceName]) {
        this.connections[fullDeviceName] = {};
      }
      this.connections[fullDeviceName][deviceUid] = {}
      this.connections[fullDeviceName][deviceUid].client = client;
      this.connections[fullDeviceName][deviceUid].tags = {};
      this.connections[fullDeviceName][deviceUid].ns = {};
      const userIdentityInfo = 
        this.getAnonymous(deviceUid)
        ? {type: UserTokenType.Anonymous}
        : {type: UserTokenType.UserName,
           userName: this.getUserName(deviceUid),
           password: this.getPassword(deviceUid)};
      client.fullDeviceAddress = fullDeviceName;
      client.connected = false;
      client.connect(fullDeviceName)
      .then( _ => client.createSession(userIdentityInfo))
      .then(session => {
        this.connections[fullDeviceName][deviceUid].session = session;
        return session.createSubscription2({
          requestedPublishingInterval: 1000,
          requestedLifetimeCount: 100, // 1000ms *100 every 2 minutes or so
          requestedMaxKeepAliveCount: 10, // every 10 seconds
          maxNotificationsPerPublish: 10,
          publishingEnabled: true,
          priority: 10
      })})
      .then(subscription => {
        subscription.on("terminated", () => {
          this.destroyConnect(client, errSubscriptionTxt, reject, deviceUid);
        })
        subscription.on("error", err => {
          this.logger('Subscription error: ' + err)
          this.destroyConnect(client, errSubscriptionTxt, reject, deviceUid);
        })
        client.connected = true;
        resolve(client);
        this.connections[fullDeviceName][deviceUid].subscription = subscription;
        this.addMonitoredTags(subscription, tags, fullDeviceName);
      })
      .catch(err => {
        this.destroyConnect(client, `${errOpcReject}:${err}`, reject, deviceUid);
      })
      client.on("backoff", _ => {
        this.destroyConnect(client, errHostCloseConnectTxt, reject, deviceUid);
      });
    });a
  }

  // add subscibe for monitored tags
  addMonitoredTags (subscription, tags, fullDeviceName, deviceUid) {
    if(!subscription) return;
    const deviceObj = this.connections[fullDeviceName] ? this.connections[fullDeviceName][deviceUid] : undefined;
    if (!deviceObj) return;
    tags.forEach(tag => {
      if (!tag.err){
        if (deviceObj.ns[tag.nodeId]){
          deviceObj.tags[tag.name] = tag;
          tag.value = this.getValueByIndex(tag, deviceObj.ns[tag.nodeId].originalValue);
          deviceObj.ns[tag.nodeId].tags.push(tag)
          return;
        }
        deviceObj.tags[tag.name] = tag;
        deviceObj.ns[tag.nodeId] = {};
        deviceObj.ns[tag.nodeId].tags = [tag]
        subscription.monitor({
          nodeId: tag.nodeId,
          attributeId: AttributeIds.Value
        },
        {
          samplingInterval: 1000,
          discardOldest: true,
          queueSize: 10
        }, 
        TimestampsToReturn.Both)
        .then(monitoredItem => {
          monitoredItem.on("changed", dataValue => this.response(dataValue, tag));
          monitoredItem.on("terminated", () => this.logger('MonitoredItem terminated'));
          monitoredItem.on("err", err => this.logger('MonitoredItem error: ' + err));
        })
      }
    })
  }

 
  /**
   * response - handler method for incoming packets from slave devices
   * @param {object} client - socket object
   * @param {Buffer} data - raw data array
   */
  response(data, tag) {
    let value = data?.value?.value ?? null;
    const sendSubscribedObj = {};
    sendSubscribedObj.deviceUid = tag.deviceUid;
    sendSubscribedObj.values = {};

    if (this.connections[tag.endpointUrl] && this.connections[tag.endpointUrl][tag.deviceUid] && this.connections[tag.endpointUrl][tag.deviceUid].ns[tag.nodeId]) {
      this.connections[tag.endpointUrl][tag.deviceUid].ns[tag.nodeId].tags.forEach(tag => {
        this.connections[tag.endpointUrl][tag.deviceUid].ns[tag.nodeId].originalValue = value;
        this.connections[tag.endpointUrl][tag.deviceUid].tags[tag.name].value = this.getValueByIndex(tag, value);
        if(tag.subscribed){
          sendSubscribedObj.values[tag.name] = this.getValueByIndex(tag, value);
        }
      })
    }
    if(Object.keys(sendSubscribedObj.values).length > 0) this.subscribeHandler(sendSubscribedObj);

  }

  // correction value for 64bit tags
  correct64 (tag, value) {
    if(tag.nodeType !== DataType.Int64 && tag.nodeType !== DataType.UInt64) {
      return isNaN(parseFloat(value)) ? value.toString() : value;
    }
    if (tag.nodeType == DataType.Int64) {
      return this.int64HiLoToString(value[0], value[1])
    } else {
      return this.uint64HiLoToString(value[0], value[1])
    }
  }

  // returns string interpretation for int64 value
  int64HiLoToString(hi,lo){
    hi>>>=0;
    lo>>>=0;
    let sign="";
    if(hi&0x80000000){
      sign="-";
      lo=(0x100000000-lo)>>>0;
      hi=0xffffffff-hi+ +(lo===0);
    }
    let dhi = ~~(hi/0x5af4);
    let dhirem = hi % 0x5af4;
    let dlo= dhirem * 0x100000000 + dhi * 0xef85c000 + lo;
    dhi += ~~(dlo / 0x5af3107a4000);
    dlo %= 0x5af3107a4000;
    let slo = "" + dlo;
    if(dhi){
      slo="000000000000000000".slice(0, 14 - slo.length) + dlo;
      return sign + dhi + slo;
    }else{
      return sign + slo;
    }
  }

    // returns string interpretation for uint64 value
  uint64HiLoToString(hi,lo){
    hi>>>=0;
    lo>>>=0;
    let dhi = ~~(hi/0x5af4);
    let dhirem = hi % 0x5af4;
    let dlo= dhirem * 0x100000000 + dhi * 0xef85c000 + lo;
    dhi += ~~(dlo / 0x5af3107a4000);
    dlo %= 0x5af3107a4000;
    let slo = "" + dlo;
    if(dhi){
      slo="000000000000000000".slice(0, 14 - slo.length) + dlo;
      return dhi + slo;
    }else{
      return slo;
    }
  }

  getValueByType (tag, value) {
    if(value !== null){
      switch(tag.type){ 
        case 'datetime':
          return moment(new Date(value)).unix() * 1000;
        case 'bool':
          return value ? 1 : 0
        case 'string':
          return value.toString().slice(0, maxStringSize)
        default:
          return this.correct64(tag, value)
      }
    }
  }

  isIterable(obj) {
    if (obj == null) {
      return false;
    }
    return typeof obj[Symbol.iterator] === 'function';
  }

  // split value from tags array
  getValueByIndex (tag, value) {
    if(value === undefined) return null;
    if(tag.arrayIndex === -1) return this.getValueByType(tag, value)
    const values = this.isIterable(value) ? [...value] : [value]
    return tag.arrayIndex < values.length ? this.getValueByType(tag, values[tag.arrayIndex]) : null;
  }

  /**
   * getTagProperty - common function-getter for device property
   * @param {array of objects} tags - tags objects array with options for requests
   * @param {string} property - property name
   * @returns {*} property value
   */
  getTagProperty(tags, property){
    for(let i = 0; i < tags.length; i++){
      if(tags[i][property] !== undefined) return tags[i][property];
    }
    return null;
  }

  /**
   * getEndpointUrl - returns getEndpointUrl for opcua device
   * @param {array of objects} tags - tags objects array with options for requests
   * @returns {string}
   */
  getEndpointUrl(tags){
    return this.getTagProperty(tags, 'endpointUrl');
  }

  /**
   * getDeviceUid - returns unique identificator of device
   * @param {array of objects} tags - tags objects array with options for requests
   * @returns {string}
   */
  getDeviceUid(tags){
    return this.getTagProperty(tags, 'deviceUid');
  }

  // common method getting property of device
  getDeviceProperty(deviceUid, property){
    if(!deviceUid) return null;
    return this.deviceList.list[deviceUid]?.options[property]?.currentValue ?? null;
  }

  // get securityMode for opc server
  getDeviceSecurityMode(deviceUid){
    return this.getDeviceProperty(deviceUid, 'securityMode');
  }

  // get securityPolicy for opc server
  getDeviceSecurityPolicy(deviceUid){
    return this.getDeviceProperty(deviceUid, 'securityPolicy');
  }

  // get certificateFile for opc server
  getCertificateFile(deviceUid){
    return this.getDeviceProperty(deviceUid, 'certificateFile');
  }

  // get privateKeyFile for opc server
  getPrivateKeyFile(deviceUid){
    return this.getDeviceProperty(deviceUid, 'privateKeyFile');
  }

  // get anonymous mode for opc server
  getAnonymous(deviceUid){
    return this.getDeviceProperty(deviceUid, 'anonymous') ?? true;
  }

  // get userName for opc server
  getUserName(deviceUid){
    return this.getDeviceProperty(deviceUid, 'userName');
  }

  // get password for opc server
  getPassword(deviceUid){
    return this.getDeviceProperty(deviceUid, 'password');
  }


  /**
   * getTimeout - returns timeout for answering of opcua server
   * @param {array of objects} tags - tags objects array with options for requests
   * @returns {int}
   */
  getTimeout(deviceUid){
    return this.getDeviceProperty(deviceUid, 'timeout');
  }

  /**
   * getFullDeviceAddress - returns full device name
   * @param {array of objects | string} ref - tags objects array with options for requests | device uid
   * @returns {string}
   */
  getFullDeviceAddress(ref){
    if(typeof(ref) === 'object'){
      return this.getEndpointUrl(ref);
    }else{
      try{
        const endpointUrl = this.deviceList.list[ref].options.endpointUrl.currentValue;
        return endpointUrl;
      }catch(e){
        return null;
      }
    }
  }
}

module.exports = CustomDriver;
