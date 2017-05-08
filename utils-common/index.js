// hello, world => Hello, world!
export function firstUppercase(str) {
    return str.substr(0,1).toUpperCase()+str.substr(1);
}
export function objectEquals(x, y) {
    if (x === null || x === undefined || y === null || y === undefined) {
        return x === y;
    }
    if (x.constructor !== y.constructor) {
        return false;
    }
    if (x instanceof Function) {
        return x === y;
    }
    if (x instanceof RegExp) {
        return x === y;
    }
    if (x === y || x.valueOf() === y.valueOf()) {
        return true;
    }
    if (Array.isArray(x) && x.length !== y.length) {
        return false;
    }
    if (x instanceof Date) {
        return false;
    }
    if (!(x instanceof Object)) {
        return false;
    }
    if (!(y instanceof Object)) {
        return false;
    }

    let p = Object.keys(x);
    return Object.keys(y).every(i => p.indexOf(i) !== -1) && p.every(i => objectEquals(x[i], y[i]));
}
export function flatten(array, result = []) {
    if (!(array instanceof Array)) throw new TypeError('"array" argument is not a array!');
    for (let i = 0; i < array.length; i++) {
        const value = array[i];

        if (Array.isArray(value)) {
            flatten(value, result);
        }
        else {
            result.push(value);
        }
    }

    return result;
}
export function removeDuplicates(array) {
    if (!(array instanceof Array)) throw new TypeError('"array" argument is not a array!');
    return Array.from(new Set(array));
}
export function mix(array1, array2) {
    //if (!(array1 instanceof Array) || !!(array2 instanceof Array)) throw new TypeError('One of arguments is not a array! ('+(typeof array1)+', '+(typeof array2)+')');
    if (typeof array1 !== typeof array2) throw new TypeError('Both arguments must have same types!');
    let out;
    if (array1 instanceof Array) {
        out = [];
        for (let index in array1) {
            out.push([array1[index], array2[index]]);
        }
        return out;
    }else if(array1 instanceof Object){
        out={};
        for(let key in array1){
            out[key]=array1[key];
        }
        for(let key in array2){
            out[key]=array2[key];
        }
        return out;
    }else{
        throw new TypeError('Unknown input type!');
    }

}
export function createPrivateEnum(...values) {
    let returnObj = {};
    values.map(value => value.toUpperCase());
    values.forEach(value => returnObj[value] = Symbol(value));
    return returnObj;
}
export function fixLength(string, length, insertPre = false, symbol = ' ') {
    if (string.length < length) {
        while (string.length < length) {
            string = insertPre ? symbol + string : string + symbol;
        }
    }
    else if (string.length > length) {
        try {
            string = string.match(insertPre ? new RegExp(`.*(.{${length}})`) : new RegExp(`(.{${length}})`))[0];
        }
        catch (e) {}
    }
    return string;
}
export function objectMap(object,cb){
    let ret = [];
    let keys=Object.keys(object);
    let values=Object.values(object);
    for(let i=0;i<keys.length;i++)
        ret.push(cb(values[i],keys[i],object));
    return ret;
}
export function arrayKVObject(keys,values){
    let len=keys.length;
    if(len!==values.length)
        throw new Error('Both arrays must have same length!');
    let result={};
    for(let i=0;i<len;i++)
        result[keys[i]]=values[i];
    return result;
}
export function sleep (time) {
	return new Promise((res, rej) => {
		setTimeout(res, time);
	});
}

/**
 * Like iterable.map(cb),
 * but cb can be async
 * @param iterable Array to process
 * @param cb Function to do with each element
 */
export function asyncEach (iterable, cb) {
	let waitings = [];
	iterable.forEach(iter => {
		waitings.push(cb(iter));
	});
	return Promise.all(waitings);
}

/**
 * Convert callback function to async
 * @param cbFunction Function to convert
 */
export function cb2promise (cbFunction) {
	return (...args) => {
		return new Promise((res, rej) => {
			cbFunction(...args, (err, result) => {
				if (err) return rej(err);
				res(result);
			});
		});
	};
}
export function hashCode(s){
    let hash = 0;
    if (s.length == 0) return hash;
    for (let i = 0; i < s.length; i++) {
        let character = s.charCodeAt(i);
        hash = ((hash<<5)-hash)+character;
        hash = hash & hash;
    }
    return hash;
}