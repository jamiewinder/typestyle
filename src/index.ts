import * as types from "./types";

/**
 * @module Maintains a single stylesheet and keeps it in sync with requested styles
 */
import * as FreeStyle from "free-style";

/** Raf for node + browser */
const raf = typeof requestAnimationFrame === 'undefined' ? setTimeout : requestAnimationFrame;

/**
 * Only calls cb all sync operations settle
 */
const {afterAllSync} = new class {

  pending = 0;
  afterAllSync = (cb: () => void) => {
    this.pending++;
    const pending = this.pending;
    raf(() => {
      if (pending !== this.pending) return;
      cb();
    })
  }
}

type Dictionary = { [key: string]: any; };

/**
 * Before we send styles to freeStyle we should convert any CSSType<T> to string
 * Call this whenever something might be a CSSType.
 */
export function ensureString(x: any): string {
  return typeof (x as types.CSSType<any>).type === 'string'
    ? x.toString()
    : x;
}

/**
 * Ensures string for all values of an object
 */
export function ensureStringObj(object: any): types.CSSProperties {
  const result: types.CSSProperties & Dictionary = {};
  for (const key in object) {
    const val = object[key];
    result[key] = ensureString(val);

    /** TypeStyle configuration options */
    if (key === '$unique') {
      const atKey = FreeStyle.IS_UNIQUE;
      const objToPutBack = result[key];
      delete result[key];
      result[atKey] = objToPutBack;
    }
  }
  return result;
}


/**
 * We have a single stylesheet that we update as components register themselves
 */
let freeStyle = FreeStyle.create();
let lastFreeStyleChangeId = freeStyle.changeId;

/**
 * We create a tag on first request or return the one that was hydrated
 */
const {setTag, getTag} = new class {
  singletonTag?: { innerHTML: string } = undefined;
  getTag = () => {
    if (!this.singletonTag) {
      this.singletonTag = typeof window === 'undefined' ? { innerHTML: '' } : document.createElement('style');
      if (typeof document !== 'undefined') document.head.appendChild(this.singletonTag as any);
    }
    return this.singletonTag;
  }
  setTag = (tag: { innerHTML: string }) => {
    /** Clear any data in any previous tag */
    if (this.singletonTag) {
      this.singletonTag.innerHTML = '';
    }
    this.singletonTag = tag;
    /** This special time buffer immediately */
    forceRenderStyles();
  }
};

/** Sets the target tag where we write the css on style updates */
export const setStylesTarget = setTag;

/** Checks if the style tag needs updating and if so queues up the change */
const styleUpdated = () => {
  if (
    freeStyle.changeId === lastFreeStyleChangeId
    && !pendingRawChange
  ) return;

  lastFreeStyleChangeId = freeStyle.changeId;
  pendingRawChange = false;
  afterAllSync(forceRenderStyles);
};

let pendingRawChange = false;
let raw = '';

/**
 * Insert `raw` CSS as a string. This is useful for e.g.
 * - third party CSS that you are customizing with template strings
 * - generating raw CSS in JavaScript
 * - reset libraries like normalize.css that you can use without loaders
 */
export function cssRaw(mustBeValidCSS: string) {
  if (!mustBeValidCSS) return;
  raw = raw + mustBeValidCSS;
  pendingRawChange = true;
  styleUpdated();
}

/**
 * Renders styles to the singleton tag imediately
 * NOTE: You should only call it on initial render to prevent any non CSS flash.
 * After that it is kept sync using `requestAnimationFrame` and we haven't noticed any bad flashes.
 **/
export function forceRenderStyles() {
  getTag().innerHTML = css();
}

/**
 * Helps with testing. Reinitializes FreeStyle + raw
 */
export function reinit() {
  /** reinit freestyle */
  freeStyle = FreeStyle.create();
  lastFreeStyleChangeId = freeStyle.changeId;

  /** reinit raw */
  raw = '';
  pendingRawChange = false;

  /** Clear any styles that were flushed */
  getTag().innerHTML = '';
}

/**
 * Allows use to use the stylesheet in a node.js environment
 */
export const css = () => raw ? raw + freeStyle.getStyles() : freeStyle.getStyles();

/**
 * Takes CSSProperties and return a generated className you can use on your component
 */
export function style(...objects: types.NestedCSSProperties[]) {
  const object = extend(...objects);
  const className = freeStyle.registerStyle(object);
  styleUpdated();
  return className;
}

export function fontFace(...fontFace: types.FontFace[]): void {
  for (const face of fontFace) {
    freeStyle.registerRule('@font-face', face);
  }
  styleUpdated();
  return;
}

/**
 * Takes CSSProperties and registers it to a global selector (body, html, etc.)
 */
export function cssRule(selector: string, ...objects: types.NestedCSSProperties[]): void {
  const object = extend(...objects);
  freeStyle.registerRule(selector, object);
  styleUpdated();
  return;
}

/**
 * Takes Keyframes and returns a generated animation name
 */
export function keyframes(frames: types.KeyFrames) {
  // resolve keyframe css property helpers
  for (const key in frames) {
    const frame = frames[key] as Dictionary;
    for (const prop in frame) {
      frame[prop] = ensureString(frame[prop]);
    }
  }
  const animationName = freeStyle.registerKeyframes(frames);
  styleUpdated();
  return animationName;
}

/**
 * Helper for you to create a CSSFunction
 * Assumption is that most css function fall into this pattern:
 * `function-name(param [, param])`
 */
export function cssFunction(functionName: string, ...params: types.CSSValueGeneral[]): string {
  const parts = params.map(ensureString).join(',');
  return `${functionName}(${parts})`;
}

/**
 * Merges various styles into a single style object.
 * Note: if two objects have the same property the last one wins
 */
export function extend(...objects: types.NestedCSSProperties[]): types.NestedCSSProperties {
  /** The final result we will return */
  const result: types.CSSProperties & Dictionary = {};
  for (const object of objects) {
    for (const key in object) {

      /** Falsy values except a explicit 0 is ignored */
      const val: any = (object as any)[key];
      if (!val && val !== 0) {
        continue;
      }

      // if freestyle media or pseudo selector
      if ((key.indexOf('&') !== -1 || key.indexOf('@media') === 0)) {
        result[key] = result[key] ? extend(result[key] as any, val) : ensureStringObj(val);
      }

      // if nested media or pseudo selector
      else if (key === '$nest' && val) {
        const nested = object.$nest!;
        for (let selector in nested) {
          const subproperties = nested[selector]!;
          result[selector] = result[selector] ? extend(result[selector], subproperties) : ensureStringObj(subproperties);
        }
      }
      else {
        // And we already have something for this key
        result[key] = ensureString(val);
      }
    }
  }
  return result;
}

/**
 * Utility to join classes conditionally
 */
export function classes(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(c => !!c).join(' ');
}

/**
 * Helps customize styles with media queries
 */
export const media = (mediaQuery: types.MediaQuery, ...objects: types.CSSProperties[]): types.CSSProperties => {
  const mediaQuerySections: string[] = [];
  if (mediaQuery.type) mediaQuerySections.push(mediaQuery.type);
  if (mediaQuery.orientation) mediaQuerySections.push(mediaQuery.orientation);
  if (mediaQuery.minWidth) mediaQuerySections.push(`(min-width: ${mediaQuery.minWidth}px)`);
  if (mediaQuery.maxWidth) mediaQuerySections.push(`(max-width: ${mediaQuery.maxWidth}px)`);

  const stringMediaQuery = `@media ${mediaQuerySections.join(' and ')}`;

  const object = {
    $nest: {
      [stringMediaQuery]: extend(...objects)
    }
  };
  return object;
}
