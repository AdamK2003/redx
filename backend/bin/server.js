require("dotenv").config();

const express = require("express");
const _ = require("underscore");
const { param, query, matchedData, validationResult } = require("express-validator");
const assert = require("assert");

const makeInventoryLink = require("../data/inventorylink");
const { writePackedObject } = require("../lib/objectloader");
const { getRecordUri, getRecordIdType, fetchRecord, fetchDirectoryChildren, parseRecordUri, getParentDirectoryRecordStub, isRecordUri, areRecordsEqual, isAssetUri } = require("../lib/cloudx");
const { searchRecords, searchPendingRecords, getRecord, buildSearchQuery, buildChildrenQuery, MAX_SIZE, buildExactRecordQuery, buildNotDeletedQuery, meiliFilter, meiliJoinFilter, meiliMultiFilter } = require("../lib/db");
const { sendSearchResponse, buildFulltextQuery, processLocalHits, LINK_ENDPOINT_VERSION, sendBrowseResponse } = require("../lib/server-utils");
const guillefix = require("../lib/guillefix");
const routeAliases = require("../lib/route-aliases");
const { indexBy, promiseTry, ax } = require("../lib/utils");
const { defineAlias } = routeAliases;
const roots = require("../data/roots");
const { rateLimit } = require("express-rate-limit");

const app = express();

app.set("json spaces", 2);

app.set("port", process.env.PORT || 8002);
app.set("trust proxy", "loopback");

app.use((req, res, next) => {
  let trust = req.app.get('trust proxy fn'),
    host = req.get('X-Forwarded-Host');
  if(!host || !trust(req.connection.remoteAddress, 0))
    host = req.get('Host');
  else if(host.indexOf(',') !== -1)
    host = host.substring(0, host.indexOf(',')).trimRight();

  let protocol = req.get("X-Forwarded-Proto");
  if(!protocol || !trust(req.connection.remoteAddress, 0))
    protocol = req.protocol;

  req.realHost = host;
  req.realProtocol = protocol;
  req.fullBaseUrl = `${req.realProtocol}://${req.realHost}${req.baseUrl}`;
  next();
});

routeAliases.install(app);

// Frontend
app.use(express.static(__dirname + "/../redx-frontend/build"));
app.get("/", (req, res, next) => {
  res.sendFile(__dirname + "/../redx-frontend/build/index.html");
});

function validateRequest(req) {
  const errors = validationResult(req);
  if(!errors.isEmpty()) {
    req.res.status(400).json({ message: "Invalid request", errors: errors.array() });
    return false;
  }
  return true;
}

const listReqParams = [
  param("format").isIn(["animx", "animj", "json"]),
  query("size").isInt({ min: 1, max: 200 }).toInt().optional(),
  query("from").isInt({ min: 0 }).toInt().optional(),
  query("v").isInt({ min: -(2 ** 31), max: (2 ** 31) - 1 }).toInt().optional()
];

app.get(defineAlias("search", "/search.:format"), [
  query("type").toArray(),
  query("search_type").toArray(),
  query("q").trim().optional(),
  query("image_weight").isFloat({ min: 0, max: 1 }).toFloat().optional(),
  listReqParams,
], async (req, res, next) => {
  let { format, type, q, size, from, v, image_weight, search_type } = _.defaults(matchedData(req), {
    image_weight: 0, size: 10, from: 0, q: "", v: 0, search_type: ['search_name', 'search_author', 'search_tags']
  });
  if(!validateRequest(req)) return;

  console.log(`search`, q, size, from);
  let types = [];

  for(let t of type) {
    types.push(String(t));
  }



  await promiseTry( () => {
    // if(image_weight === 0 || q === "")
    return { hits: [], total: 0 }; // guillefix stub

    // return guillefix.searchRecordsCached({
    //   f: "1e-9", // fuzzy
    //   t: "0", // text
    //   i: "1", // image
    //   q
    // }).catch(err => {
    //   console.log(`guillefix endpoint error: ${err.stack || err}`);
    //   return { hits: [], total: 0 };
    // });
  }).then(async ({ hits: imageSearchHits }) => {
    // let fulltextQuery = buildFulltextQuery(q, imageSearchHits, image_weight);


    let where = [];

    if(search_type.includes('search_name')) where.push('simpleName');
    if(search_type.includes('search_author')) where.push('ownerName');
    if(search_type.includes('search_path')) where.push('pathNameSearchable');
    if(search_type.includes('search_tags')) where.push('tagsSearchable');

    if(where.length == 0) where = ['simpleName', 'ownerName', 'pathNameSearchable', 'tagsSearchable'];

    // console.log(where)

    return await searchRecords(buildSearchQuery(q, types, where), size, from);
  }).then(({ total, hits }) => {
    processLocalHits(hits, req.buildUrl.bind(req), format);
    sendSearchResponse(res, format, hits, { v, total, });
  }).catch(next);
});

// app.get(defineAlias("search-guillefix", "/search-guillefix.:format"), [
//   query("q").trim().optional(),
//   query("f").isFloat().toFloat().optional(),
//   query("t").isFloat().toFloat().optional(),
//   query("i").isFloat().toFloat().optional(),
//   listReqParams,
// ], async (req, res, next) => {
//   const { format, q, f, t, i, size, from, v } = _.defaults(matchedData(req), {
//     size: 10, from: 0, q: "", v: 0
//   });
//   if(!validateRequest(req))
//     return;

//   const fulltextQuery = buildSearchQuery(q, ['object'], ['simpleName', 'ownerPathNameSearchable', 'tagsSearchable'], false);

//   const localHits = await searchRecords(fulltextQuery, size, from).then(({ total, hits }) => {
//     processLocalHits(hits, req.buildUrl.bind(req), format);s
//     return { total, hits };
//   });

//   const guillefixHits = null;

//   // const guillefixHits = guillefix.searchRecordsCached({ q, f, t, i }, size, from).then(({ hits, total }) => {
//   //   for(let rec of hits) {
//   //     rec.spawnUri = rec.assetUri;
//   //     rec.spawnParentUri = null;
//   //   }

//   //   return { total, hits };
//   // }).catch(err => {
//   //   console.log(`guillefix endpoint error: ${err.stack || err}`);
//   //   return null;
//   // });

//   Promise.all([localHits, guillefixHits]).then(([localHits, guillefixHits]) => {
//     const { total, hits } = guillefixHits || localHits;
//     sendSearchResponse(res, format, hits, { v, total, });
//   }).catch(next);
// });

app.get("/asset/:id", [], async (req, res, next) => {



  if(!req.params.id) {
    res.status(400).json({ message: "Invalid request" });
    return;
  }

  const { id } = req.params;
  const { format, filename } = req.query;

  // console.log(`asset`, id, format, filename);

  let downloadFilename = (filename || id) + (format ? ('.' + format) : '');

  // serve download from assets.resonite.com/:id, but use our filename

  ax(`https://assets.resonite.com/${id}`, {
    responseType: "stream"
  }).then(response => {
    res.set('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    response.data.pipe(res);
  }).catch(err => {
    console.log(err);
    res.status(404).json({ message: "Asset not found" });
  });

  

});

function isOwnerId(id) {
  let type = getRecordIdType(id);
  return type === "U" || type === "G";
}

function isRecordId(id) {
  return getRecordIdType(id) === "R";
}

function createRecord404Handler(res) {
  return (err) => {
    if(err !== "404")
      throw err;
    res.status(404).json({ message: "Record not found" });
  };
}

app.get(defineAlias("link", "/link.:format"), [
  query("target").trim().custom(isRecordUri),
  query("targetName").trim().notEmpty(),
  param("format").isIn(["bson", "brson", "lz4bson"]),
], (req, res, next) => {
  const { target, targetName, format } = matchedData(req);
  if(!validateRequest(req))
    return;

  const stream = writePackedObject(makeInventoryLink(target, targetName), format);
  stream.pipe(res);
});

function getParentDirectoryRecords(rec, depth, includeSelf = true) {
  let parts = rec.path.split("\\");
  if(rec.recordType === "directory" && includeSelf)
    parts.push(rec.name);

  depth = Math.max(depth, 1); // skip Inventory

  // const should = [];
  // let names = [];
  // let paths = [];
  let filterExpressions = [];
  for(let i = Math.min(depth, parts.length - 1); i < parts.length; i++) {
    let path = (parts.slice(0, i).join("\\"));
    let name = (parts[i]);

    filterExpressions.push(meiliJoinFilter([meiliFilter('path', path), meiliFilter('name', name)], 'AND'));
    // should.push({
    //   bool: {
    //     filter: [
    //       { term: { path: String(parts.slice(0, i).join("\\")) } },
    //       { term: { "name.name": String(parts[i]) } }
    //     ]
    //   }
    // });
  }

  let filter = [];
  filter.push(meiliFilter('ownerId', rec.ownerId));
  filter.push(meiliJoinFilter(filterExpressions, 'OR'));

  let query = buildSearchQuery("", ["directory"], null, false, filter, "AND", false);

  // const query2 = {
  //   bool: {
  //     should,
  //     minimum_should_match: 1,
  //     filter: [
  //       { term: { recordType: "directory" } },
  //       { term: { ownerId: String(rec.ownerId) } },
  //       buildNotDeletedQuery(),
  //     ],
  //   }
  // };

  return searchRecords(query, parts.length, 0).then(({ total, hits }) => {
    return _.sortBy(hits, h => h.path.length);
  });
}

function getParentDirectoryRecord(rec) {
  return getParentDirectoryRecords(rec, Infinity, false).then(parents => parents[0] || null);
}

app.get(defineAlias("parent-link", "/parent-link.:format"), [
  query("ownerId").trim().custom(isOwnerId),
  query("id").trim().custom(isRecordId),
  query("depth").isInt({ min: 0 }).toInt().optional(),
  param("format").isIn(["bson", "brson", "lz4bson"]),
], (req, res, next) => {
  const { ownerId, id, depth, format } = _.defaults(matchedData(req), { depth: 0 });
  if(!validateRequest(req))
    return;

  getRecord({ ownerId, id }).then(rec => {
    if(!rec)
      throw "404";

    return getParentDirectoryRecords(rec, depth);
  }).then(parents => {
    console.log(parents);
    if(!parents.length)
      throw "404";
    const parentRec = parents[0];

    const stream = writePackedObject(makeInventoryLink(getRecordUri(parentRec), parentRec.name), format);
    stream.pipe(res);
  }).catch(createRecord404Handler(res)).catch(next);
});

function isValidHistArray(value) {
  return _.all(value, item => {
    const parsed = new URLSearchParams(item);
    return parsed.has("ownerId") && parsed.has("id");
  });
}

function parseHistArray(value) {
  return value.map(item => {
    const parsed = new URLSearchParams(item);
    return {
      ownerId: parsed.get("ownerId"),
      id: parsed.get("id"),
      incoming: parsed.has("incoming")
    };
  });
}

function serializeHistArray(value) {
  return value.map(item => {
    const params = new URLSearchParams;
    params.append("ownerId", item.ownerId);
    params.append("id", item.id);
    if(item.incoming)
      params.append("incoming", "");
    return params.toString();
  });
}

function createSpecialLink(data) {
  return _.extend({
    ownerId: null,
    ownerName: null,
    id: null,
    name: "",
    tags: [],
    recordType: "special",
    objectType: null,
    path: "",
    assetUri: null,
    thumbnailUri: null,
  }, data);
}

const browseReqParams = [
  query("ownerId").trim().custom(isOwnerId),
  query("id").trim().custom(isRecordId),
  query("incoming").toBoolean(),
  query("hist").toArray().custom(isValidHistArray).customSanitizer(parseHistArray),
  listReqParams,
];

app.get(defineAlias("browse", "/browse.:format"), browseReqParams, (req, res, next) => {
  const { ownerId, id, incoming, size, from, hist, format, v } = _.defaults(matchedData(req), {
    size: 10, from: 0, hist: [], v: 0
  });
  if(!validateRequest(req))
    return;

  const MAX_HIST_LENGTH = 10;

  if(hist.length >= MAX_HIST_LENGTH)
    hist.splice(0, MAX_HIST_LENGTH - hist.length + 1); // remove one more than limit to make space for new entries

  // TODO: handle incoming parameter

  function getBackLink(hist) {
    if(!hist.length)
      return createSpecialLink({
        name: "(back)",
      });

    const lastEntry = hist[hist.length - 1];
    const rest = hist.slice(0, hist.length - 1);

    return createSpecialLink({
      name: "(back)",
      browseUri: req.buildUrl("browse", {
        format,
        ownerId: lastEntry.ownerId,
        id: lastEntry.id,
        incoming: lastEntry.incoming || undefined,
        hist: serializeHistArray(rest),
      }, true)
    });
  }

  function getUpLink(rec, newHist) {
    return getParentDirectoryRecord(rec).then(parentRec => {
      if(!parentRec)
        return createSpecialLink({
          name: "(up)",
        });

      return createSpecialLink({
        name: "(up)",
        browseUri: req.buildUrl("browse", {
          format,
          ownerId: parentRec.ownerId,
          id: parentRec.id,
          hist: serializeHistArray(newHist),
        }, true)
      });
    });
  }

  function resolveHistEntries(hist) {
    const startLen = 2, endLen = 3;

    const should = [];
    for(let i = 0; i < hist.length; i++) {
      if(i < startLen || i >= hist.length - endLen) {
        const { ownerId, id } = hist[i];
        should.push(buildExactRecordQuery({ ownerId, id }));
      }
    }

    const query = {
      bool: {
        should,
        minimum_should_match: 1,
        filter: [
          { term: { recordType: "directory" } },
          buildNotDeletedQuery(),
        ],
      }
    };

    return searchRecords(query, MAX_SIZE).then(({ hits }) => {
      const hitsByUrl = indexBy(hits, rec => getRecordUri(rec));
      const res = [];
      let spacerIndex = -1;
      for(let i = 0; i < hist.length; i++) {
        if(i < startLen || i >= hist.length - endLen) {
          const rec = hitsByUrl.get(getRecordUri(hist[i]));
          if(rec)
            res.push({
              name: rec.name,
              browseUri: req.buildUrl("browse", {
                format,
                ownerId: rec.ownerId,
                id: rec.id,
                hist: serializeHistArray(hist.slice(0, i)),
              }, true)
            });
        } else if(spacerIndex === -1) {
          spacerIndex = res.length;
          res.push({
            name: "...",
            browseUri: null
          })
        }
      }
      if(res.length === startLen + endLen + 1 && spacerIndex !== -1 && spacerIndex < res.length)
        res.splice(spacerIndex + 1, 1);
      return res;
    });
  }

  function redirectToRecord(rec, hist) {
    res.redirect(req.buildUrl("browse", {
      ownerId: rec.ownerId,
      id: rec.id,
      size, from, hist: serializeHistArray(hist), format, v,
    }));
  }

  getRecord({ ownerId, id }).then(rec => {
    if(!rec)
      throw "404";

    if(rec.recordType === "link") {
      if(!isRecordUri(rec.assetUri))
        throw new Error("Invalid link");
      redirectToRecord(parseRecordUri(rec.assetUri), hist);
      throw "break";
    }

    if(rec.recordType !== "directory")
      throw new Error(`Unsupported record type: ${rec.recordType}`);

    const newHist = [...hist, { ownerId, id, incoming }];

    const query = {
      bool: {
        filter: [
          buildChildrenQuery(rec),
          buildNotDeletedQuery(),
        ]
      }
    };

    const sort = [
      { "name.name": "asc" },
    ];

    return Promise.all([
      from <= 0 && from + size > 0 && getBackLink(hist),
      from <= 1 && from + size > 1 && getUpLink(rec, newHist),
      searchRecords(query, size + Math.min(0, from - 2), Math.max(0, from - 2), { sort }),
      resolveHistEntries(newHist),
    ]).then(([backLink, upLink, { total, hits }, resolvedHist]) => {
      if(upLink)
        hits.unshift(upLink);
      if(backLink)
        hits.unshift(backLink);
      total += 2;

      const modalTitle = `Browse: ${rec.name}`;
      const spawnUri = getRecordUri(rec);

      processLocalHits(hits, req.buildUrl.bind(req), format, serializeHistArray(newHist));
      sendBrowseResponse(res, format, hits, resolvedHist, { v, total, modalTitle, spawnUri });
    });
  }).catch(createRecord404Handler(res)).catch(err => {
    if(err !== "break")
      throw err;
  }).catch(next);
});

app.get(defineAlias("browse-parent", "/browse-parent.:format"), [
  browseReqParams,
  query("depth").isInt({ min: 0 }).toInt().optional(),
], (req, res, next) => {
  const { ownerId, id, incoming, size, from, hist, format, v, depth } = _.defaults(matchedData(req), {
    size: 10, from: 0, hist: [], v: 0, depth: 0,
  });
  if(!validateRequest(req))
    return;

  getRecord({ ownerId, id }).then(rec => {
    if(!rec)
      throw "404";

    return getParentDirectoryRecords(rec, depth);
  }).then(parents => {
    if(!parents.length)
      throw "404";
    const parentRec = parents[0];

    if(hist.length && hist[hist.length - 1].ownerId === parentRec.ownerId && hist[hist.length - 1].id === parentRec.id)
      hist.pop(); // prevent duplication of last history entry

    res.redirect(req.buildUrl("browse", {
      ownerId: parentRec.ownerId,
      id: parentRec.id,
      incoming: incoming || undefined,
      size, from, hist: serializeHistArray(hist), format, v,
    }));
  }).catch(createRecord404Handler(res)).catch(next);
});

function getIncomingLinkRecords(recordStub, includeDeleted = true) {
  assert(!!recordStub.ownerId, "ownerId must be specified");
  assert(recordStub.id || recordStub.path, "id or path must be specified");

  const should = [];

  // look up incoming links by id
  if(recordStub.id) {
    should.push({
      bool: {
        filter: [
          { term: { recordType: "link" } },
          { term: { assetUri: getRecordUri(recordStub, false) } },
        ]
      }
    });
  }

  // incoming links by path & name
  if(recordStub.path && recordStub.name) {
    should.push({
      bool: {
        filter: [
          { term: { recordType: "link" } },
          { term: { assetUri: getRecordUri(recordStub, true) } },
        ]
      }
    });
  }

  const filter = [];
  if(!includeDeleted)
    filter.push(buildNotDeletedQuery());

  return searchRecords({
    bool: {
      should,
      minimum_should_match: 1,
      filter,
    }
  }, MAX_SIZE).then(({ hits }) => hits);
}

const originLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

app.get(defineAlias("origin", "/origin.json"), [
  query("record").trim().custom(isRecordUri),
  query("maxDepth").isInt({ min: 0, max: 5 }).toInt().optional(),

  // rate limit only valid requests
  (req, res, next) => validateRequest(req) && next(),
  originLimiter,
], (req, res, next) => {
  const { record: recordUri, maxDepth = 3 } = matchedData(req);
  if(!validateRequest(req))
    return;

  const includeDeleted = false;

  function getRootRecords() {
    const parsedRoots = roots.map(parseRecordUri).filter(Boolean);
    if(!parsedRoots.length)
      return Promise.resolve([]);
    return searchRecords({
      bool: {
        should: parsedRoots.map(rootStub => buildExactRecordQuery(rootStub)),
        minimum_should_match: 1,
      }
    }, MAX_SIZE).then(({ hits }) => hits);
  }

  getRootRecords().then(rootRecords => {
    function fetchInfo(recordStub, stack = []) {
      return promiseTry(() => {
        const foundCircular = stack.find(rec => areRecordsEqual(rec, recordStub));
        if(foundCircular)
          return { ...foundCircular, circular: true };

        const foundRoot = rootRecords.find(root => areRecordsEqual(root, recordStub));
        if(foundRoot)
          return { ...foundRoot, root: true };

        if(stack.length >= maxDepth)
          return { ...recordStub, maxDepthExceeded: true };

        return getRecord(recordStub, false, includeDeleted).then(record => {
          if(!record)
            return { ...recordStub, notFound: true };

          const foundCircular = stack.find(rec => areRecordsEqual(rec, record));
          if(foundCircular)
            return { ...foundCircular, circular: true };

          const foundRoot = rootRecords.find(root => areRecordsEqual(root, recordStub));
          if(foundRoot)
            return { ...foundRoot, root: true };

          const parentRecordStub = getParentDirectoryRecordStub(record);
          return getIncomingLinkRecords(record, includeDeleted).then(incomingLinks => {
            const newStack = [...stack, record];

            return Promise.all([
              parentRecordStub ? fetchInfo(parentRecordStub, newStack) : null,
              ...incomingLinks.flatMap(linkRecord => {
                const linkParent = getParentDirectoryRecordStub(linkRecord);
                return linkParent ? [fetchInfo(linkParent, newStack)] : [];
              }),
            ]).then(([parent, ...linkedFrom]) => {
              return { ...record, parent, linkedFrom: linkedFrom.filter(Boolean), };
            });
          });
        });
      }).then(record => ({
        recordUri: getRecordUri(record),
        ..._.pick(record, ["ownerId", "ownerName", "id", "path", "name", "recordType", "parent", "linkedFrom", "circular", "notFound", "maxDepthExceeded", "root"]),
      }));
    }

    const recordStub = parseRecordUri(recordUri);
    return fetchInfo(recordStub);
  }).then(info => {
    res.json(info);
  }).catch(next);
});

app.use((req, res, next) => {
  res.status(404).json({ message: `Cannot ${req.method} ${req.path}` });
})

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: err.message });
});

app.listen(app.get("port"), (err) => {
  if(err) {
    console.log(`app.listen failed: ${err.message || err}`);
    return;
  }
  console.log(`app.listen ${app.get("port")}`);
});
