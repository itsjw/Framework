import Logger from '@meteor-it/logger';
import potatoSuperProto from './potatoSuperProto.js';
import proxyDeep from 'proxy-deep';

// Autoreconnection socket

function processProtocol(protocolDeclaration) {
    let out={
        events:new Map(),
        rpc:new Map(),

        eventToId:new Map(),
        idToEvent:new Map(),

        rpcToId:new Map(),
        idToRpc:new Map()
    };
    let eventId=0;
    let rpcEventId=0;
    for(let key of Object.keys(protocolDeclaration).sort()){
        if(!protocolDeclaration.hasOwnProperty(key))
            continue;
        if(!key.includes('::')){
            let id=eventId++;
            out.eventToId.set(key,id);
            out.idToEvent.set(id,key);
            out.events.set(key,protocolDeclaration[key]);
        }else{
            let [rpcEvent,type]=key.split('::');
            if(!['request','response'].includes(type))
                throw new Error('Wrong RTC subevent type: '+rpcEvent+'::'+type);
            if(!out.rpc.has(rpcEvent)) {
                let id=rpcEventId++;
                out.rpcToId.set(rpcEvent,id);
                out.idToRpc.set(id,rpcEvent);
                out.rpc.set(rpcEvent, new Map());
            }
            out.rpc.get(rpcEvent).set(type,protocolDeclaration[key]);
        }
    }
    return out;
}

/**
 * Websocket wrapper with auto-reconnection
 */
export class WebSocketClient {
    number = 0; // Message id
    autoReconnectInterval;
    url;
    instance;
    safeClose = false;
    constructor(url, reconnectInterval=100) {
        this.autoReconnectInterval = reconnectInterval; // ms
        this.url=url;
    }

    /**
     * Opens connection
     */
    open() {
        this.safeClose=false;
        this.instance = new WebSocket(this.url);
        this.instance.binaryType = 'arraybuffer';
        this.instance.onopen = () => {
            this.onOpenResend();
            this.onopen();
        };
        this.instance.onmessage = (data, flags) => {
            this.number++;
            this.onmessage(data, flags, this.number);
        };
        this.instance.onclose = (e) => {
            if (!this.safeClose){
                switch (e) {
                    case 1000: // CLOSE_NORMAL
                        this.onclose(e);
                        break;
                    default: // Abnormal closure
                        this.reconnect();
                        break;
                }
            }else{
                this.onclose(e);
            }
        };
        this.instance.onerror = (e) => {
            switch (e.code) {
                case 'ECONNREFUSED':
                    if (!this.safeClose)
                        this.reconnect();
                    else
                        this.onclose(e);
                    break;
                default:
                    this.onerror(e);
                    break;
            }
        };
    }

    /**
     * Closes connection
     */
    close() {
        this.safeClose = true;
        this.instance.close();
    }

    sendBuffer=[];

    /**
     * Sends data to remote socket or saves to buffer if not available
     * @param data 
     * @param option 
     */
    send(data, option?) {
        try {
            this.instance.send(data, option);
        } catch (e) {
            this.sendBuffer.push([data,option]);
        }
    }

    /**
     * Reconnects to a websocket
     */
    reconnect() {
        if (!this.safeClose) {
            setTimeout(() => {
                this.open();
            }, this.autoReconnectInterval);
        }
    }

    /**
     * After successful reconnection send all buffered data to remote
     */
    onOpenResend(){
        for(let [data,option] of this.sendBuffer)
            this.send(data,option);
        this.sendBuffer=[];
    }

    onopen() {
    }

    onmessage(data, flags, number) {
    }

    onerror(e) {
    }

    onclose(e) {
    }
}

export class RPCError extends Error{
    constructor(message){
        super(message.toString());
    }
}

/**
 * Common potato.socket implementation
 * Universal side (Use any protocol)
 */
export class PotatoSocketUniversal{
    logger;
    /**
     * If true - socket is managed by server (Or smth)
     * @type {boolean}
     */
    isServant;
    /**
     * If true - pass this to event/rpc handlers
     * @type {boolean}
     */
    isThisNeeded;
    server;
    timeout;
    constructor(name,protocolDeclaration,isServant=false,isThisNeeded=false,timeout=20000){
        this.isServant=isServant;
        this.isThisNeeded=isThisNeeded;
        this.timeout=timeout;
        if(name)
            this.logger=new Logger(name);
        if(protocolDeclaration)
            this.processDeclaration(protocolDeclaration);
    }

    /**
     * Id's should equal on sender and receiver
     * @type {number}
     */
    lastEventId=0x1;
    /**
     * id=>declaration map
     * @type {Array}
     * @private
     */
    _events=[];
    /**
     * event name=>id map
     * @type {{}}
     */
    eventToId={};
    /**
     * id=>event name map
     * @type {{}}
     */
    idToEvent={};

    /**
     * Id's should equal on sender and receiver
     * @type {number}
     */
    lastRpcEventId=0x3;
    /**
     * id=>[request declaration,response declaration] map
     * @type {Array}
     * @private
     */
    _rpc=[];
    /**
     * event name=>id map
     * @type {{}}
     */
    rpcToId={};
    /**
     * id=>event name map
     * @type {{}}
     */
    idToRpc={};

    /**
     * Local defined RPC methods
     * methodId=>handler map
     * @type {{}}
     */
    rpcMethods={};

    /**
     * RPC Core
     * @returns {*}
     */
    get rpc(){
        let self=this;
        return proxyDeep({},{
            get(target, path, receiver, nest){
                let methodName=path.join('.');
                if(!self.rpcToId[methodName])
                    return nest();
                return (...data)=>{
                    if(data.length!==1)
                        throw new Error('Wrong method call argument count: '+data.length);
                    if(!(data[0] instanceof Object))
                        throw new Error('Argument is not a object');
                    return self.callRemoteMethod(self.rpcToId[methodName],data[0]);
                }
            },
            set(target, path, value){
                // Local method declaration
                // Example: socket.rtc.a.b.c=({data})=>{return data+1}
                if(self.isServant)
                    throw new Error('Cannot add RPC method on servant!');
                let methodName=path.join('.');
                if(!self.rpcToId[methodName])
                    throw new Error(`Method declaration are not in pds: ${methodName}\nExisting methods: ${Object.keys(self.rpcToId).join(', ')}`);
                if(!(value instanceof Function))
                    throw new Error(`RPC method declaration are not a function type: ${methodName}`);
                if(self.isThisNeeded){
                    if(value.length!==2)
                        throw new Error(`RPC method declaration must be (socket, data)=>{...}: ${methodName}`);
                }else{
                    if(value.length!==1)
                        throw new Error(`RPC method declaration must be (data)=>{}: ${methodName}`);
                }
                self.rpcMethods[self.rpcToId[methodName]]=value;
                return true;
            }
        });
    }

    /**
     * Local rpc calls
     */
    get local(){
        // TODO: Real local rpc
        let self=this;
        return {
            get rpc(){
                return self.rpc;
            },
            get emit(){
                return self.emit;
            },
            get on(){
                return self.on;
            }
        }
    }

    /**
     * Remote rpc calls
     */
    get remote(){
        let self=this;
        return {
            get rpc(){
                return self.rpc;
            },
            get emit(){
                return self.emit;
            },
            get on(){
                return self.on;
            }
        }
    }

    /**
     * Random emulation
     */
    lastRpcMethodCallId=0;
    /**
     * random=>[resolve,reject] map
     */
    pendingRemoteRPCCalls:{[key:number]:[(data:any)=>any,(error:Error)=>any]}={};

    /**
     * Rpc call (sender side)
     * @param methodId method id to call
     * @param data raw data
     */
    callRemoteMethod(methodId: number,data: any):Promise<any>{
        console.log(methodId,this.idToRpc[methodId],this.rpcToId[this.idToRpc[methodId]]);
        return new Promise((res,rej)=>{
            // TODO: Random?
            let random=this.lastRpcMethodCallId++;
            let body=Array.from(this.serializeByDeclaration(data,this._rpc[methodId][0]));
            let timeoutCalled=false;
            let timeoutTimeout=setTimeout(()=>{
                timeoutCalled=true;
                rej(new RPCError('Local execution timeout'));
            },this.timeout*1.5);
            this.pendingRemoteRPCCalls[random]=[(d)=>{
                if(timeoutCalled)
                    return;
                clearTimeout(timeoutTimeout);
                res(d);
            },(e)=>{
                if(timeoutCalled)
                    return;
                clearTimeout(timeoutTimeout);
                rej(e)
            }];
            this.sendBufferToRemote(this.serializeByDeclaration({
                tag:'rpcCall',
                data:{
                    random,
                    body: {
                        eventId:methodId,
                        body
                    }
                }
            },potatoSuperProto.potatoSocket));
        });
    }

    /**
     * Rpc call (receiver side)
     * @param packet
     */
    onLocalMethodCall(packet){
        let random=packet.random;
        let methodId=packet.body.eventId;
        if(!this._rpc[methodId]) {
            this.answerErrorOnRPCCall(random,'Protocol version mismatch? (Non existing method id)');
            this.logger.error('Received non existing RPC method id!');
            return;
        }
        if(!this.rpcMethods[methodId]) {
            this.answerErrorOnRPCCall(random,'Protocol version mismatch? (Non existing method declaration)');
            this.logger.error(`Received not declared (via socket.rtc.${this.idToRpc[methodId]}=...) method call!`);
            return;
        }
        let data=this.deserializeByDeclaration(Buffer.from(packet.body.body),this._rpc[methodId][0]);
        try{
            let timeoutCalled=false;
            let timeoutTimeout=setTimeout(()=>{
                this.answerErrorOnRPCCall(random,'Remote execution timeout');
                this.logger.error('Local method execution timeout');
                timeoutCalled=true;
            },this.timeout);
            let methodResult;
            if(this.isThisNeeded){
                methodResult=this.rpcMethods[methodId](this,data);
            }else{
                methodResult=this.rpcMethods[methodId](data);
            }
            if(!(methodResult instanceof Promise))
                this.logger.error('Method returned not a promise!');
            methodResult.then(data=>{
                if(timeoutCalled)
                    return;
                clearTimeout(timeoutTimeout);
                this.answerOkOnRPCCall(random,methodId,data);
            }).catch(e=>{
                if(timeoutCalled)
                    return;
                clearTimeout(timeoutTimeout);
                this.logger.error(e.stack);
                this.answerErrorOnRPCCall(random,e.message);
            })
        }catch(e){
            this.logger.error(e.stack);
            this.answerErrorOnRPCCall(random,e.message);
        }
    }

    /**
     * Rpc error (sender side)
     * @param random
     * @param rpcError
     */
    answerErrorOnRPCCall(random,rpcError){
        this.sendBufferToRemote(this.serializeByDeclaration({
            tag:'rpcErr',
            data: {
                random,
                body:{
                    eventId:0,
                    body:Buffer.from(rpcError)
                }
            }
        },potatoSuperProto.potatoSocket));
    }

    /**
     * Rpc error (receiver side)
     * @param packet
     */
    onRemoteMethodError(packet){
        let random=packet.random;
        // let methodId=packet.body.eventId; // Always equals 0
        if(!this.pendingRemoteRPCCalls[random]) {
            this.logger.error('Unknown random: ' + random);
            return;
        }
        let errorText=Buffer.from(packet.body.body).toString();
        let error=new RPCError(errorText);
        this.pendingRemoteRPCCalls[random][1](error);
        delete this.pendingRemoteRPCCalls[random];
    }

    /**
     * Rpc ok (sender side)
     * @param random
     * @param methodId
     * @param data
     */
    answerOkOnRPCCall(random,methodId,data){
        let body;
        try {
            body = this.serializeByDeclaration(data, this._rpc[methodId][1]);
            this.sendBufferToRemote(this.serializeByDeclaration({
                tag:'rpcOk',
                data: {
                    random,
                    body:{
                        eventId:methodId,
                        body
                    }
                }
            },potatoSuperProto.potatoSocket));
        }catch(e){
            this.answerErrorOnRPCCall(random,'Server error: Response serialization failed');
            this.logger.error(data);
            this.logger.error('Response serialization error:');
            this.logger.error(e.stack);
            if(body){
                this.logger.error('This is fatal (in core) error!')
                this.logger.error(body);
                this.logger.error(body.length);
            }
        }
    }

    /**
     * Rpc ok (receiver side)
     * @param packet
     */
    onRemoteMethodOk(packet){
        let random=packet.random;
        let methodId=packet.body.eventId;
        if(!this.pendingRemoteRPCCalls[random]) {
            this.logger.error('Unknown random: ' + random);
            return;
        }
        if(!this._rpc[methodId]) {
            this.logger.error('Unknown response method id: ' + methodId);
            return;
        }
        let data=this.deserializeByDeclaration(Buffer.from(packet.body.body), this._rpc[methodId][1]);
        this.pendingRemoteRPCCalls[random][0](data);
        delete this.pendingRemoteRPCCalls[random];
    }

    /**
     * Local defined event handlers
     * eventId=>[...handlers] map
     * @type {{}}
     */
    eventHandlers={};

    /**
     * Called when packet with tag: event received
     * @param packet
     */
    onRemoteEvent(packet){
        let eventId=packet.eventId;
        if(!this._events[eventId]) {
            this.logger.error('Received event with wrong event id!');
            return;
        }
        let data;
        try{
            data=this.deserializeByDeclaration(Buffer.from(packet.body),this._events[eventId]);
            if(!this.eventHandlers[eventId]){
                if(!(this.isThisNeeded&&this.isServant&&this.server.eventHandlers[eventId])) {
                    this.logger.warn(`No event handlers are defined for received packet: ${this.idToEvent[eventId]}`);
                    return;
                }
            }
        }catch(e){
            this.logger.error('Received packet with wrong data!');
            return;
        }
        // This one
        if(this.eventHandlers[eventId]) {
            this.eventHandlers[eventId].forEach(handler => {
                try {
                    handler(data)
                } catch (e) {
                    this.logger.error('Error thrown from socket event handler!');
                    this.logger.error(e.stack);
                }
            });
        }
        // Server
        if(this.isThisNeeded&&this.isServant&&this.server.eventHandlers[eventId]){
            this.server.eventHandlers[eventId].forEach(handler=> {
                try {
                    handler(this,data)
                } catch (e) {
                    this.logger.error('Error thrown from server event handler!');
                    this.logger.error(e.stack);
                }
            });
        }
    }
    /**
     * Send event
     * @param eventName
     * @param eventData
     */
    emit(eventName,eventData){
        let eventId=this.eventToId[eventName];
        if(!eventId)
            throw new Error('Trying to emit not existing packet!');
        try{
            let body=this.serializeByDeclaration(eventData,this._events[eventId]);
            let data={
                tag:'event',
                data:{
                    eventId,
                    body
                }
            };
            let buffer=this.serializeByDeclaration(data,potatoSuperProto.potatoSocket);
            this.sendBufferToRemote(buffer);
        }catch(e){
            this.logger.error(JSON.stringify(eventData));
            this.logger.error(`Data serialization error for "${eventName}"`);
            this.logger.error(e.stack);
        }
    }
    /**
     * Define received event handler
     * @param eventName
     * @param handler
     */
    on(eventName,handler){
        let eventId=this.eventToId[eventName];
        if(!eventId) {
            let possible=Object.keys(this.eventToId);
            throw new Error(`Trying to listen for not existing packet: ${eventName}\nExisting packets: ${possible.join(', ')}`);
        }
        if(!this.eventHandlers[eventId])
            this.eventHandlers[eventId]=[];
        this.eventHandlers[eventId].push(handler);
    }

    /**
     * Networking.
     * Send buffer to receiver side
     * @param buffer
     */
    sendBufferToRemote(buffer){
        console.error(buffer);
        throw new Error('PotatoSocketUniversal have no sendBufferToRemote method declaration!\nUse class extending it!');
    }

    /**
     * Networking
     * Got buffer from sender side
     * @param buffer
     */
    gotBufferFromRemote(buffer){
        let packet=this.deserializeByDeclaration(buffer,potatoSuperProto.potatoSocket);
        switch (packet.tag){
            case 'rpcCall':
                this.onLocalMethodCall(packet.data);
                break;
            case 'rpcErr':
                this.onRemoteMethodError(packet.data);
                break;
            case 'rpcOk':
                this.onRemoteMethodOk(packet.data);
                break;
            case 'event':
                this.onRemoteEvent(packet.data);
                break;
            default:
                this.logger.error('Received unknown potatoSuperProto packet: '+packet.tag);
        }
    }

    // noinspection JSMethodCanBeStatic
    /**
     * Serialize via protodef
     * @param data data to serialize
     * @param declaration serializer
     * @returns {Buffer} serialized data
     */
    serializeByDeclaration(data,declaration){
        let length=declaration.sizeOf(data);
        let buffer=Buffer.allocUnsafe(length);
        declaration.serialize(data,buffer,0);
        return buffer;
    }

    // noinspection JSMethodCanBeStatic
    /**
     * Deserialize via protodef
     * @param buffer data to deserialize
     * @param declaration deserializer
     * @returns {*} deserialized data
     */
    deserializeByDeclaration(buffer,declaration){
        return declaration.deserialize(buffer, 0)[0];
    }

    /**
     * Add event (used in initialization stage)
     * @param event
     * @param declaration
     */
    processAddSimpleEvent(event,declaration){
        let id=this.lastEventId++;
        this.eventToId[event]=id;
        this.idToEvent[id]=event;
        this._events[id]=declaration;
    }

    /**
     * Add RPC method (used in initialization stage)
     * @param eventPath
     * @param request
     * @param response
     */
    processAddRpcMethod(eventPath,request,response){
        let id=this.lastRpcEventId++;
        this.rpcToId[eventPath]=id;
        this.idToRpc[id]=eventPath;
        this._rpc[id]=[request,response];
    }

    /**
     * Add events/methods (used in initialization stage)
     * @param declaration
     */
    processDeclaration(declaration) {
        let keys=Object.keys(declaration).sort();
        for(let key of keys){
            if(!declaration.hasOwnProperty(key))
                continue;
            let lastParts=key.split('::');
            let lastPart=lastParts[lastParts.length-1];
            if(lastPart!=='request'&&lastPart!=='response'){
                let path = key.split('::');
                if(path[0]==='')
                    path=path.slice(1);
                this.processAddSimpleEvent(path.join('.'),declaration[key]);
            }else{
                let path = key.split('::').slice(0,-1);
                if(path[0]==='')
                    path=path.slice(1);
                let prefix = key.slice(0,key.lastIndexOf('::'));
                if(this.rpcToId[path.join('.')])
                    continue;
                let requestDeclaration=declaration[prefix+'::request'];
                let responseDeclaration=declaration[prefix+'::response'];
                if(!requestDeclaration)
                    throw new Error(`Rpc call ${prefix} has no request declaration!`);
                if(!responseDeclaration)
                    throw new Error(`Rpc call ${prefix} has no response declaration!`);
                this.processAddRpcMethod(path.join('.'),requestDeclaration,responseDeclaration);
            }
        }
    }
}

/**
 * Websocket potato.socket client
 */
export class PotatoSocketClient extends PotatoSocketUniversal {
    websocketAddress:string;
    websocket:WebSocketClient;

    constructor(name, protocolDeclaration, websocketAddress, reconnectInterval) {
        super(name, protocolDeclaration, false, false);
        this.websocketAddress=websocketAddress;
        this.websocket=new WebSocketClient(this.websocketAddress, reconnectInterval);
        this.websocket.onopen=()=>{
            this.openHandlers.forEach(handler=>handler());
        };
        this.websocket.onclose=status =>{
            this.closeHandlers.forEach(handler=>handler(status));
        };
        this.websocket.onerror = error => {
            this.logger.error(error.stack||error);
        };
        this.websocket.onmessage = (data) => {
            this.gotBufferFromRemote(Buffer.from(data.data));
        };
    }
    openHandlers=[];
    closeHandlers=[];
    on(event,listener){
        if(event==='open'){
            if(listener.length!==0)
                throw new Error('"open" listener should receive 0 arguments!');
            this.openHandlers.push(listener);
            return;
        }
        if(event==='close'){
            if(listener.length!==1)
                throw new Error('"close" listener should receive 1 argument (status)!');
            this.closeHandlers.push(listener);
            return;
        }
        super.on(event,listener);
    }
    sendBufferToRemote(buffer){
        this.websocket.send(buffer);
    }
    open(){
        this.websocket.open();
    }
    close(){
        this.websocket.close();
    }
}

/**
 * For internal use
 */
class PotatoSocketServerInternalClient extends PotatoSocketUniversal{
    websocket;
    constructor(server,websocket){
        super(null,null,true,true);
        this.server=server;
        this.websocket=websocket;
        this.logger=server.logger;
        this.lastEventId=-1;
        this._events=server._events;
        this.eventToId=server.eventToId;
        this.idToEvent=server.idToEvent;
        this.lastRpcEventId=-1;
        this._rpc=server._rpc;
        this.rpcToId=server.rpcToId;
        this.idToRpc=server.idToRpc;
        this.rpcMethods=server.rpcMethods;
        websocket.on('message',data=>{
            this.gotBufferFromRemote(Buffer.from(data));
        });
    }
    sendBufferToRemote(buffer){
        this.websocket.send(buffer);
    }
}

/**
 * Websocket potato.socket server
 */
export class PotatoSocketServer extends PotatoSocketUniversal {
    clients={};
    constructor(name, protocolDeclaration) {
        super(name,protocolDeclaration,false,true);
    }

    /**
     * Emit data to every connected socket
     * @param eventName
     * @param eventData
     */
    emit(eventName:string,eventData:any){
        let eventId=this.eventToId[eventName];
        if(!eventId)
            throw new Error('Trying to emit not existing packet!');
        try{
            let body=this.serializeByDeclaration(eventData,this._events[eventId]);
            let buffer=this.serializeByDeclaration({
                tag:'event',
                data:{
                    eventId,
                    body
                }
            },potatoSuperProto.potatoSocket);
            for(let client of this.clients){
                client.sendBufferToRemote(buffer);
            }
        }catch(e){
            this.logger.error(JSON.stringify(eventData));
            this.logger.error(`Data serialization error for "${eventName}"`);
            this.logger.error(e.stack);
        }
    }
    openHandlers=[];
    closeHandlers=[];
    /**
     * Warning: this "on" listens for "connection" events only!
     */
    on(event,listener){
        if(event==='open'){
            if(listener.length!==1)
                throw new Error('"open" listener should receive 1 argument (socket)!');
            this.openHandlers.push(listener);
            return;
        }
        if(event==='close'){
            if(listener.length!==1)
                throw new Error('"close" listener should receive 1 argument (socket)!');
            this.closeHandlers.push(listener);
            return;
        }
        super.on(event,listener);
    }
    handler(req,websocket){
        let wrappedSocket=new PotatoSocketServerInternalClient(this,websocket);
        let id=Math.random().toString(32).substr(2);
        (<any>wrappedSocket).id=id;
        if(req.session)
            (<any>wrappedSocket).session=req.session;
        this.clients[id]=wrappedSocket;
        websocket.on('close',()=>{
            delete this.clients[id];
            this.closeHandlers.forEach(handler=>{
                handler(wrappedSocket);
            })
        });
        this.openHandlers.forEach(handler=>{
            handler(wrappedSocket);
        });
    }
}