// -*- mode: typescript; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingTalk
//
// Copyright 2017-2020 The Board of Trustees of the Leland Stanford Junior University
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>

import assert from 'assert';
import * as semver from 'semver';

import type * as Ast from './ast';

// the old grammar
import * as Grammar from './grammar';
// the old nnsyntax
import * as LegacyNNSyntax from './nn-syntax';

// the new grammar
import Parser from './new-syntax/parser';
import { surfaceLexer } from './new-syntax/lexer';
import { nnLexer } from './new-syntax/nn-lexer';
import { prettyprint } from './new-syntax/pretty';
import { nnSerialize } from './new-syntax/nn-serializer';
import {
    EntityMap,
    EntityResolver,
    MeasureEntity,
    LocationEntity,
    TimeEntity,
    GenericEntity,
    DateEntity,
    AnyEntity
} from './entities';
import {
    AbstractEntityRetriever,
    EntityRetriever,
    SequentialEntityAllocator,
} from './entity-retriever';

/**
 * APIs to parse and serialize ThingTalk code.
 *
 * @namespace
 * @alias Grammar
 */

export enum SyntaxType {
    Legacy,
    LegacyNN,

    Normal,
    Tokenized,
}

/**
 * Parse a string into a ThingTalk {@link Ast}
 *
 * @param {string} code - the ThingTalk code to parse
 * @return {Ast.Input} the parsed program, library or permission rule
 */
export function parse(code : string|string[], syntaxType : SyntaxType.Tokenized|SyntaxType.LegacyNN, entities : EntityMap|EntityResolver) : Ast.Input;
export function parse(code : string, syntaxType ?: SyntaxType.Normal|SyntaxType.Legacy) : Ast.Input;
export function parse(code : string|string[], syntaxType : SyntaxType = SyntaxType.Normal, entities ?: EntityMap|EntityResolver) : Ast.Input {
    let input : Ast.Input;
    if (syntaxType === SyntaxType.Tokenized) {
        input = new Parser().parse(nnLexer(code, entities!));
    } else if (syntaxType === SyntaxType.LegacyNN) {
        input = LegacyNNSyntax.fromNN(code, entities!);
    } else if (syntaxType === SyntaxType.Normal) {
        assert(typeof code === 'string');
        input = new Parser().parse(surfaceLexer(code as string));
    } else {
        // workaround grammar bug with // comments at the end of input
        input = Grammar.parse(code + '\n') as any;
    }
    const optimized = input.optimize();
    if (!optimized)
        throw new Error(`Program is empty after optimization`);
    return optimized;
}

export interface SerializeOptions {
    typeAnnotations ?: boolean;
    compatibility ?: string;
}

/**
 * Serialize a ThingTalk AST node to a surface form, either in human-readable
 * syntax or in tokenized syntax suitable for machine prediction.
 *
 * @param node - the program to serialize
 * @param entityRetriever - object to use to retrieve entities
 * @param [options={}] - additional options
 * @param options.typeAnnotations - include type annotations for parameters
 *   (only meaningful to legacy NN syntax)
 */
export function serialize(node : Ast.Input, syntaxType : SyntaxType.LegacyNN, entities : AbstractEntityRetriever, options ?: SerializeOptions) : string[];
export function serialize(node : Ast.Node, syntaxType : SyntaxType.Tokenized, entities : AbstractEntityRetriever, options ?: SerializeOptions) : string[];
export function serialize(node : Ast.Node, syntaxType ?: SyntaxType.Normal|SyntaxType.Legacy) : string;
export function serialize(node : Ast.Node,
                          syntaxType : SyntaxType = SyntaxType.Normal,
                          entityRetriever ?: AbstractEntityRetriever,
                          options : SerializeOptions = {}) : string|string[] {

    if (syntaxType === SyntaxType.Tokenized && options.compatibility &&
        semver.satisfies(options.compatibility, '1.*')) {
        syntaxType = SyntaxType.LegacyNN;
        entityRetriever!.setSyntaxType(syntaxType);

        const serialized = LegacyNNSyntax.toNN(node as Ast.Input, entityRetriever!, options);
        LegacyNNSyntax.applyCompatibility(serialized, options.compatibility);
        return serialized;

        // if we introduce compatibility fixes for new syntax, they will go here as well
    } else if (syntaxType === SyntaxType.Tokenized || syntaxType === SyntaxType.LegacyNN) {
        entityRetriever!.setSyntaxType(syntaxType);

        if (syntaxType === SyntaxType.Tokenized)
            return nnSerialize(node.toSource(), entityRetriever!);
        else
            return LegacyNNSyntax.toNN(node as Ast.Input, entityRetriever!, options);
    } else if (syntaxType === SyntaxType.Normal) {
        return prettyprint(node.toSource());
    } else {
        throw new Error(`Prettyprinting to legacy syntax is no longer supported`);
    }
}

// reexport entity API so Genie can subclass
export {
    AbstractEntityRetriever,
    SequentialEntityAllocator,
    EntityRetriever,

    EntityMap,
    EntityResolver,
    MeasureEntity,
    LocationEntity,
    TimeEntity,
    GenericEntity,
    DateEntity,
    AnyEntity
};
