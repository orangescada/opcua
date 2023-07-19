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
  NodeClass,
  NodeIdType,
  coerceVariantType
} = require("node-opcua");
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

// class implements OPCUA driver
class CustomDriver{
  /**
   *  Class constructor
   *  @param {object} deviceList - list of devices and nodes
   *  @param {method} subscribeHandler - handler calling then subscribed value changes
   *  @param {method} getConfigHandler - handler for reading driver config
   *  @param {method} setConfigHandler - handler for writing driver config
   */
  constructor(deviceList, subscribeHandler, getConfigHandler, setConfigHandler){
    this.deviceList = deviceList;
    this.connections = {};
    this.subscribeHandler = subscribeHandler;
    this.getConfigHandler = getConfigHandler;
    this.setConfigHandler = setConfigHandler;
    this.updateSubscribe();
  }

  getDeviceStatus(dataObj){
    let device = this.deviceList.list ? this.deviceList.list[dataObj.uid] : null;
    if(!device) return {active: false};
    dataObj.deviceUid = dataObj.uid;
    let firstTag = Object.keys(device.tags)[0];
    dataObj.tags = firstTag ? [firstTag] : [];
    let fullDeviceName = this.getFullDeviceAddress(dataObj.uid);
    if(!this.connections[fullDeviceName]){
      this.getTagsList('read', dataObj)
      .then(tags => this.createConnect(tags, dataObj.uid))
      .catch( _ => {});
      return {active: false};
    }
    return {active: this.connections[fullDeviceName].client.connected};
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
      .then(tags => this.opcuaWriteRequest(tags))
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

  restartDevice(dataObj) {
    const deviceId = dataObj.cmd === 'setTag' ? dataObj.deviceUid : dataObj.uid;
    const fullDeviceName = this.getFullDeviceAddress(deviceId);
    if(fullDeviceName){
      const client = this.connections[fullDeviceName]?.client;
      if(client) this.destroyConnect(client, restartOnChangeTxt);
    }
  }

  /**
   * updateTagListFromDevice - this method must be implements if driver can abserve tags
   * @param {object} dataObj - object contains device for tags update
   * @returns {boolean} true if config has updated, otherwise false
   */
  updateTagListFromDevice(dataObj){
    /*let config = this.getConfigHandler();
    ***Update config here***
    this.setConfigHandler(config);*/
    console.log("updateTagListFromDevice", dataObj) //deviceUid
    const fullDeviceName = this.getFullDeviceAddress(dataObj.deviceUid);
    if(this.deviceList.list[dataObj.deviceUid]?.options.browseTrigger?.currentValue !== "Start") return false;
    if(!fullDeviceName) return false;
    const session = this.connections[fullDeviceName]?.session;
    if(!session) return false;
    
    this.browseTags(session)
    .then(browseTags => console.log("browseTags=", browseTags));
    return false;
  }

  getNodeId(nodeId) {
    let res = "";
    if(nodeId.namespace) res = `ns=${nodeId.namespace};`;
    if(nodeId.identifierType > 0) {
      const nodeType = ["i","s","g","b"][nodeId.identifierType - 1];
      res += `${nodeType}=${nodeId.value}`;
    }
    return res;
  }

  getNodeType(nodeId) {
    if(nodeId.identifierType === NodeIdType.NUMERIC) return 'int';
    return 'string';
  }

  browseTags(session, nodeToBrowse = "RootFolder", folder = "/", browseTags = []) {
    return new Promise(resolve => {
      let chain = Promise.resolve();
      console.log("nodeToBrowse=", nodeToBrowse.value);
      chain = chain.then( _ => {
        return new Promise(resolve => {
          session.browse(nodeToBrowse)
          .then(browseResult => resolve(browseResult))
          .catch(err => {
            console.log("browse error=", err)
            resolve(null);
          })
        })
      })
      chain = chain.then(browseResult => {
        if(browseResult) {
          browseResult.references.forEach(ref => {
            console.log("ref.browseName.toString()", ref.browseName.toString())
            if(ref.nodeClass === NodeClass.Variable) { 
              browseTags.push({
                "name": ref.displayName.text,
                "nodeId": this.getNodeId(ref.nodeId),
                "type": this.getNodeType(ref.nodeId)
              });
            }
            if(ref.nodeClass === NodeClass.Object) chain = chain.then( _ => this.browseTags(session, ref.nodeId, "/", browseTags))
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
      dataObj.tags = Object.keys(this.deviceList.list[item].tags);
      const tags = this.deviceTagsToArray('read', this.deviceList.list[item], dataObj, true);
      const fullDeviceName = this.deviceList.list[item].options.endpointUrl.currentValue;
      const tagNames = tags.map(tag => tag.name);
      dataObj.tags.forEach(tag => {
        if(this.connections[fullDeviceName]?.tags[tag]){
          this.connections[fullDeviceName].tags[tag].subscribed = tagNames.includes(tag)
        }
      })
      if(tags.length > 0){
        this.opcuaReadRequest(tags, item)
        .catch(err => console.log(err))
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

  opcuaGetValues(tags, fullDeviceName) {
    return new Promise(resolve => resolve(tags.reduce((acc, tag) => {
      return [...acc, this.connections[fullDeviceName]?.tags[tag.name]?.value ?? null]
    }, [])))
  }

   getDataType(tag) {
    switch(tag.type) {
      case 'float':
      case 'int': 
        return DataType.Double;
      case 'datetime':
        return DataType.DateTime;
      case 'bool':
        return DataType.Boolean;
      case 'string':
        return DataType.String;
      default: 
        return DataType.Double;
    }
  }

  getSetValue(tag) {
    switch (tag.type) {
      case 'datetime': return moment(tag.setValue, dateTimeFormat).toDate();
      case 'bool': return !!tag.setValue;
      default: return tag.setValue;
    }
  }

  opcuaSetValues(tags, fullDeviceName) {
    return new Promise((resolve, reject) => {
      const session = this.connections[fullDeviceName]?.session;
      if(!session){
        reject(errEmptySession);
        return;
      }
      Promise.all(tags.map(tag => {
        return new Promise((resolve, reject) => {
          if(tag.err){
            reject(tag.err)
          }else{
            session.write({
              nodeId: tag.nodeId,
              attributeId: AttributeIds.Value,
              value: {
                statusCode: StatusCodes.Good,
                sourceTimestamp: new Date(),
                value: {
                  dataType: this.getDataType(tag),
                  value: this.getSetValue(tag)
                }
              }
            })
            .then(code => {
              if (code === StatusCodes.Good){
                resolve();
              }else{
                reject(`${errWriteFail}, error code=${code._value}`);
              }
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

  checkIfTagsInMonitor(tags, fullDeviceName) {
    const noMonitoredTags = tags.filter(tag => !this.connections[fullDeviceName]?.tags[tag.name]);
    if(noMonitoredTags.length > 0) {
      const subscription = this.connections[fullDeviceName]?.subscription;
      this.addMonitoredTags(subscription, noMonitoredTags, fullDeviceName);
    }
  }

  /**
   * opcuaWriteRequest - uplevel method for write request prepare, send requests and handling result
   * @param {object} tags - tags objects array with options for requests
   * @returns {Promise} undefined on success, text error on fail
   */
  opcuaWriteRequest(tags){
    return this.opcuaRequest(tags, this.opcuaSetValues)
  }

  opcuaRequest(tags, handler, deviceUid) {
    return new Promise((resolve,reject) => {
      try{
        let fullDeviceName = this.getFullDeviceAddress(tags);
        if (!this.connections[fullDeviceName]){
          this.createConnect(tags, deviceUid)
          .then(() => handler.call(this, tags, fullDeviceName))
          .then(res => resolve(res))
          .catch(err => reject(err))
        }else{
          this.checkIfTagsInMonitor(tags, fullDeviceName);
          handler.call(this, tags, fullDeviceName)
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


  closeSession(fullDeviceAddress) {
    return new Promise(resolve => {
      if(!this.connections[fullDeviceAddress]?.session){
        resolve()
      }else{
        this.connections[fullDeviceAddress].session.close()
        .then(() => resolve())
      }
    })
  }

  destroyConnect(client, errTxt, reject) {
    this.closeSession(client.fullDeviceAddress)
    .then(() => client.disconnect())
    .finally(() => {
      this.connections[client.fullDeviceAddress] = null;
      delete this.connections[client.fullDeviceAddress];
      client.connected = false;
      let errText = `${errTxt} ${client.fullDeviceAddress}`;
      if(reject) reject(errText);
    })
  }

  getSecurityMode(tags) {
    const securityMode = this.getDeviceSecurityMode(tags);
    switch(securityMode) {
      case 'Sign': return MessageSecurityMode.Sign;
      case 'SignAndEncrypt': return MessageSecurityMode.SignAndEncrypt;
      default: return MessageSecurityMode.None;
    }
  }

  getSecurityPolicy(tags) {
    const securityPolicy = this.getDeviceSecurityPolicy(tags);
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
      const timeout = this.getTimeout(tags) || defaultTimeout;
      const client = OPCUAClient.create({
        endpointMustExist: false,
        applicationUri: 'orangescada.opcua',
        securityMode: this.getSecurityMode(tags),
        securityPolicy: this.getSecurityPolicy(tags),
        certificateFile: this.getCertificateFile(tags),
        privateKeyFile: this.getPrivateKeyFile(tags),
        connectionStrategy: {
            maxRetry: 1,
            initialDelay: 2000,
            maxDelay: timeout
        }
      });

      const fullDeviceName = this.getFullDeviceAddress(tags.length ? tags : deviceUid);
      this.connections[fullDeviceName] = {};
      this.connections[fullDeviceName].client = client;
      this.connections[fullDeviceName].tags = {};
      const userIdentityInfo = 
        this.getAnonymous(tags)
        ? {type: UserTokenType.Anonymous}
        : {type: UserTokenType.UserName,
           userName: this.getUserName(tags),
           password: this.getPassword(tags)};
      client.fullDeviceAddress = fullDeviceName;
      client.connected = false;
      client.connect(fullDeviceName)
      .then( _ => client.createSession(userIdentityInfo))
      .then(session => {
        this.connections[fullDeviceName].session = session;
        return session.createSubscription2({
          requestedPublishingInterval: 1000,
          requestedLifetimeCount: 100, // 1000ms *100 every 2 minutes or so
          requestedMaxKeepAliveCount: 10,// every 10 seconds
          maxNotificationsPerPublish: 10,
          publishingEnabled: true,
          priority: 10
      })})
      .then(subscription => {
        subscription.on("terminated", () => {
          this.destroyConnect(client, errSubscriptionTxt, reject);
        })
        client.connected = true;
        resolve(client);
        this.connections[fullDeviceName].subscription = subscription;
        this.addMonitoredTags(subscription, tags, fullDeviceName);
      })
      .catch(err => {
        this.destroyConnect(client, `${errOpcReject}:${err}`, reject);
      })
      client.on("backoff", _ => {
        this.destroyConnect(client, errHostCloseConnectTxt, reject);
      });
    });a
  }

  addMonitoredTags (subscription, tags, fullDeviceName) {
    if(!subscription) return;
    tags.forEach(tag => {
      this.connections[fullDeviceName].tags[tag.name] = tag
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
      })
    })
  }

 
  /**
   * response - handler method for incoming packets from slave devices
   * @param {object} client - socket object 
   * @param {Buffer} data - raw data array
   */
  response(data, tag) {
    let value = data?.value?.value ?? null;
    if(value !== null){
      switch(tag.type){ 
        case 'datetime':
          value = moment(new Date(value)).unix() * 1000;
          break;
        case 'bool':
          value = value ? 1 : 0
          break;
        default:
          value = value.toString();
      }
    }
    this.connections[tag.endpointUrl].tags[tag.name].value = value ?? null;
    
    if(tag.subscribed){
      let sendSubscribedObj = {};
      sendSubscribedObj.deviceUid = tag.deviceUid;
      sendSubscribedObj.values = {};
      sendSubscribedObj.values[tag.name] = value ?? null;
      this.subscribeHandler(sendSubscribedObj);
    }
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

  getDeviceProperty(tags, property){
    const deviceId = this.getDeviceUid(tags);
    if(!deviceId) return null;
    return this.deviceList.list[deviceId]?.options[property]?.currentValue ?? null;
  }

  getDeviceSecurityMode(tags){
    return this.getDeviceProperty(tags, 'securityMode');
  }

  getDeviceSecurityPolicy(tags){
    return this.getDeviceProperty(tags, 'securityPolicy');
  }

  getCertificateFile(tags){
    return this.getDeviceProperty(tags, 'certificateFile');
  }

  getPrivateKeyFile(tags){
    return this.getDeviceProperty(tags, 'privateKeyFile');
  }

  getAnonymous(tags){
    return this.getDeviceProperty(tags, 'anonymous');
  }

  getUserName(tags){
    return this.getDeviceProperty(tags, 'userName');
  }

  getPassword(tags){
    return this.getDeviceProperty(tags, 'password');
  }


  /**
   * getTimeout - returns timeout for answering of opcua server
   * @param {array of objects} tags - tags objects array with options for requests
   * @returns {int}
   */
  getTimeout(tags){
    return this.getDeviceProperty(tags, 'timeout');
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
