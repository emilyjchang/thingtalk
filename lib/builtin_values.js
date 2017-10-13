// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2017 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const { stringEscape } = require('./escaping');

class Entity {
    constructor(id, display) {
        this.value = id;
        this.display = display||null;
    }

    toString() {
        return this.value;
    }

    toJSSource() {
        return `new __builtin.Entity(${stringEscape(this.value)}, ${stringEscape(this.display)})`;
    }
}
module.exports.Entity = Entity;

class Location {
    constructor(lat, lon, display) {
        this.x = lon;
        this.y = lat;
        this.display = display;
    }

    toString() {
        return '[Latitude: ' + Number(this.y).toFixed(5) + ' deg, Longitude: ' + Number(this.x).toFixed(5) + ' deg]';
    }

    toJSSource() {
        return `new __builtin.Location(${this.y}, ${this.x}, ${stringEscape(this.display)})`;
    }
}
module.exports.Location = Location;

class Time {
    constructor(hour, minute, second = 0) {
        this.hour = hour;
        this.minute = minute;
        this.second = 0;
    }

    // for comparisons
    valueOf() {
        return this.hour * 3600 + this.minute * 60 + this.second;
    }

    toString() {
        if (this.second === 0)
            return v.hour + ':' + (v.minute < 10 ? '0' : '') + v.minute;
        else
            return v.hour + ':' + (v.minute < 10 ? '0' : '') + v.minute + (v.second < 10 ? '0' : '') + v.second;
    }

    toJSON() {
        return this.toString();
    }

    toJSSource() {
        return `new __builtin.Time(${this.hour}, ${this.minute}, ${this.second})`;
    }
}
module.exports.Time = Time;