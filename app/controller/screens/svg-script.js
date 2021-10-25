// Copyright 2017 Todd Fleming
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
// 
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
// 
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

// SVG controller adaptor script
// * Cross-origin communication with controller
// * Manipulates SVG element classes
// * Manipulates text content

'use strict';

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

let svg = document.getElementById('svg1');
let elements = [];
let indicators = {};
let values = {};

function receiveMessage(e) {
    if (e.source !== window.parent) return;
    if (e.data.type === 'setTransform') {
        svg.style.transform = e.data.transform;
        window.parent.postMessage({ type: 'ackSetTransform' }, '*');
    } else if (e.data.type === 'setValues') {
        for (let attr in e.data.values) {
            let ind = indicators[attr];
            if (ind) {
                for (let elem of ind) {
                    let value = e.data.values[attr];
                    if (value === true) {
                        elem.classList.add('true');
                        elem.classList.remove('false');
                    } else if (value === false) {
                        elem.classList.remove('true');
                        elem.classList.add('false');
                    }
                }
            }
            let v = values[attr];
            if (v) {
                for (let elem of v) {
                    let value = e.data.values[attr];
                    if (elem.tagName === 'text') {
                        if (Number.isNaN(value)) elem.children[0].textContent = '    NaN';else if (typeof value === 'number') elem.children[0].textContent = (value < 0 ? '-' : ' ') + ('     ' + Math.abs(value).toFixed(2)).slice(-7);else elem.children[0].textContent = value + '';
                    }
                }
            }
        }
    }
};
window.addEventListener("message", receiveMessage, false);

svg.addEventListener("mousedown", e => e.preventDefault());

function mouse(name) {
    return e => {
        e.preventDefault();
        e.stopPropagation();
        let msg = { type: 'mouse', event: name, buttons: e.buttons, id: e.currentTarget.id };
        window.parent.postMessage(msg, '*');
    };
}

let mousedown = mouse('mousedown');
let mouseup = mouse('mouseup');
let mousemove = mouse('mousemove');
let click = mouse('click');
let dblclick = mouse('dblclick');
let mouseover = mouse('mouseover');
let mouseout = mouse('mouseout');
let mouseenter = mouse('mouseenter');
let mouseleave = mouse('mouseleave');

for (let elem of document.getElementsByTagName("*")) {
    var _elem$getBoundingClie = elem.getBoundingClientRect();

    let left = _elem$getBoundingClie.left,
        top = _elem$getBoundingClie.top,
        width = _elem$getBoundingClie.width,
        height = _elem$getBoundingClie.height;

    let label = elem.getAttribute('inkscape:label');
    if (!label || label[0] !== '{') continue;
    let desc;
    try {
        desc = _extends({}, JSON.parse(label), { left, top, width, height, id: elem.id });
        if (desc.classes) elem.classList.add(...desc.classes);
        for (let attr of ['type', 'action', 'axis', 'index', 'negative']) if (attr in desc) elem.classList.add(attr + '-' + desc[attr]);
        if (desc['remove-styles']) for (let s of desc['remove-styles']) elem.style.removeProperty(s);
        if (desc.indicator) {
            if (desc.indicator in indicators) indicators[desc.indicator].push(elem);else indicators[desc.indicator] = [elem];
        }
        if (desc.value) {
            if (desc.value in values) values[desc.value].push(elem);else values[desc.value] = [elem];
        }
        if (desc.type === 'button') {
            elem.onmousedown = mousedown;
            elem.onmouseup = mouseup;
            elem.onmousemove = mousemove;
            elem.onclick = click;
            elem.ondblclick = dblclick;
            elem.onmouseover = mouseover;
            elem.onmouseout = mouseout;
            elem.onmouseenter = mouseenter;
            elem.onmouseleave = mouseleave;
        }
        if ('type' in desc) elements.push(desc);
    } catch (e) {
        console.error('error parsing inkscape:label:', label);
    }
}

svg.width.baseVal.convertToSpecifiedUnits(SVGLength.SVG_LENGTHTYPE_PX);
let width = svg.width.baseVal.valueInSpecifiedUnits;
svg.height.baseVal.convertToSpecifiedUnits(SVGLength.SVG_LENGTHTYPE_PX);
let height = svg.height.baseVal.valueInSpecifiedUnits;

let loadedMsg = {
    type: 'loaded',
    width, height, elements
};
window.parent.postMessage(loadedMsg, '*');