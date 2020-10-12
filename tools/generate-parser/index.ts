// -*- mode: typescript; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingTalk
//
// Copyright 2018-2019 The Board of Trustees of the Leland Stanford Junior University
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

process.on('unhandledRejection', (up) => { throw up; });

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';

import * as Grammar from './grammar';
import * as Ast from './meta_ast';
import {
    SLRParserGenerator,
    ProcessedRule,
    ProcessedGrammar
} from './slr_generator';
import writeout from './javascript';

function readall(stream : stream.Readable) : Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const buffers : Buffer[] = [];
        let total = 0;
        stream.on('data', (buf) => {
            buffers.push(buf);
            total += buf.length;
        });
        stream.on('end', () => {
            resolve(Buffer.concat(buffers, total));
        });
        stream.on('error', reject);
        stream.resume();
    });
}

type TypeMap = { [key : string] : string };

function handleRule(rule : Ast.Rule,
                    typeMap : TypeMap) : ProcessedRule {
    const head = rule.head.map((h) => h.getGeneratorInput());

    const bodyArgs = ['$ : $runtime.ParserInterface'];
    let i = 0;
    for (const headPart of rule.head) {
        if (headPart instanceof Ast.RuleHeadPart.NonTerminal && typeMap[headPart.category])
            headPart.type = typeMap[headPart.category];

        if (headPart.name)
            bodyArgs.push(headPart.name + ': ' + headPart.type);
        else
            bodyArgs.push(`$${i++} : ` + headPart.type);
    }

    const action = `(${bodyArgs.join(', ')}) : ${rule.type} => ${rule.bodyCode}`;
    return [head, action];
}

async function processFile(filename : string,
                           grammar : ProcessedGrammar) : Promise<[Ast.Grammar, TypeMap]> {
    const fileStream = fs.createReadStream(filename);
    const input = (await readall(fileStream)).toString('utf8');
    const parsed = Grammar.parse(input);
    assert(parsed instanceof Ast.Grammar);

    const typeMap : TypeMap = {};
    for (const statement of parsed.statements) {
        if (statement.type !== undefined) {
            if (typeMap[statement.name] !== undefined &&
                typeMap[statement.name] !== statement.type)
                throw new Error(`Conflicting type declaration for ${statement.name}`);
            typeMap[statement.name] = statement.type;
        }
    }

    for (const statement of parsed.statements) {
        if (!grammar[statement.name])
            grammar[statement.name] = [];

        for (const rule of statement.rules) {
            rule.type = typeMap[statement.name] || 'any';
            grammar[statement.name].push(handleRule(rule, typeMap));
        }
    }

    return [parsed, typeMap];
}

async function main() {
    const output = process.argv[2];
    const input = process.argv[3];

    const grammar : ProcessedGrammar = {};
    let firstFile, typeMap : TypeMap;
    try {
        [firstFile, typeMap] = await processFile(path.resolve(input), grammar);
    } catch(e) {
        if (e.location) {
            console.error(`Syntax error at line ${e.location.start.line} column ${e.location.start.column}: ${e.message}`);
            process.exit(1);
        } else {
            throw e;
        }
    }

    const generator = new SLRParserGenerator(grammar, 'input', typeMap['input'] || 'any');
    await writeout(firstFile.preamble, generator, fs.createWriteStream(output), output, typeMap['input'] || 'any');
}
main();
