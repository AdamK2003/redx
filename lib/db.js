const _ = require("underscore");
const { MeiliSearch } = require("meilisearch");
const assert = require("assert");
const { raw } = require("express");

const meiliClient = new MeiliSearch({
  host: process.env.MEILI_ENDPOINT,
  apiKey: process.env.MEILI_API_KEY
});



const client = { // stub
};

const PENDING_RECORDS_IDX = "redx-pending-records-res";
let pendingIndex = meiliClient.index("redx-pending-records-res");
const RECORDS_IDX = "redx-records-res";
let recordsIndex = meiliClient.index("redx-records-res");
const MAX_SIZE = 10000;

function getHits({ body }) {
  return _.pluck(body.hits.hits, "_source");
}

function stripRichText(str) {
  return str.replace(/<([^>]*)>/g, "").trim();
}

function sanitizeRecord(rec) { // returns object with the schema we need
  if(rec.name === undefined)
    rec.name = "";
  if(rec.path === undefined)
    rec.path = "";

  rec.simpleName = stripRichText(rec.name).slice(0, 2000);
  rec.name = rec.name.slice(0, 8000);
  rec.ownerName = rec.ownerName.slice(0, 500);

  let parts = [];
  for(let p of rec.path.split("\\")) {
    p = stripRichText(p).slice(0, 48);
    if(p === "" || p === "Inventory")
      continue;
    parts.push(p);
  }

  rec.pathArray = ['Inventory', ...parts];
  rec.pathNameSearchable = parts.join(" ").slice(0, 2000) + " " + rec.simpleName;
  rec.ownerPathNameSearchable = rec.ownerName + " " + rec.pathNameSearchable;

  rec.tagsSearchable = rec.tags.join(" ").slice(0, 8000);

  delete rec.assetManifest;
  delete rec.migrationMetadata;
  delete rec.inventoryLinkUris;
  // delete rec.componentSimpleTypes;

  // searchRecords
  delete rec._id;
  delete rec._score;

  // console.log(JSON.stringify(rec, null, 2));

  return rec;
}

function meiliFilter (attribute, value, filterType = "=") {
  return `${attribute} ${filterType} '${value}'`;
}

function meiliEmpty (attribute) {
  return `${attribute} NOT EXISTS`;
}

function meiliMultiFilter (attribute, values, filterType = "=", strict = false) {
  let filters = [];
  if(typeof values == 'string') values = [values];
  if(strict && values.length == 0) {
    filters.push(meiliEmpty(attribute));
    return filters;
  }
  for(let value of values) {
    filters.push(meiliFilter(attribute, value, filterType));
  }

  return filters;
}

function meiliJoinFilter(filters, joiner = "OR") {
  if(typeof filters == 'string') return `(${filters})`;
  let out = "";
  for(filter of filters) {
    if(filter == "") continue;
    if(out == "") {
      out = filter;
      continue;
    }
    out = `${out} ${joiner} ${filter}`;
  }
  if(out == "") return "";
  out = `(${out})`;
  return out;
}

function buildSearchQuery(q, types, where = ['simpleName', 'ownerPathNameSearchable', 'tagsSearchable'], includeDeleted = true, rawFilters = [], rawFiltersJoiner = "AND") {

  let res = {};

  let recordTypes = [], objectTypes = [];
	for(let t of types) {
		if(["directory", "link", "object", "world"].includes(t))
			recordTypes.push(String(t));
		else
			objectTypes.push(String(t));
	}

  // if(recordTypes.includes("directory") && !recordTypes.includes("link")) {
  //   recordTypes.push("link");
  // }

  // if(objectTypes.length > 0 && !recordTypes.includes("object")) {
  //   recordTypes.push("object");
  // }




  const filter = [
    meiliJoinFilter([meiliJoinFilter(meiliMultiFilter('recordType', recordTypes, '=')),
    meiliJoinFilter(meiliMultiFilter('objectType', objectTypes, '=', true))], 'OR'),
  ];

  if(rawFilters?.length > 0) {
    filter.push(meiliJoinFilter(rawFilters, rawFiltersJoiner));
    filter = meiliJoinFilter(filter, "AND");
  }

  // if(q == "" || !q) {
  //   res.sort = [
  //     'lastModificationTime:desc',
  //     'creationTime:desc',
  //   ]
  // }


  console.log(filter)

  if(!includeDeleted) filter.push(buildNotDeletedQuery());

  res.q = q;
  res.filter = filter;


  return res;
}

function buildExactRecordQuery(recordStub, includeDeleted = true) {
  assert(recordStub.ownerId, "ownerId must be specified");
  assert(recordStub.id || (recordStub.path && recordStub.name), "either id or both path and name must be specified");

  let filter = [
    `ownerId = '${String(recordStub.ownerId)}'`,
  ];

  if(recordStub.id) {
    filter.push(meiliFilter('id', recordStub.id));
  } else {
    filter.push(
      meiliJoinFilter([meiliFilter('path', recordStub.path),
      meiliFilter('name', recordStub.name)], "AND")
    );
  }

  // console.log(filter)

  if(!includeDeleted) filter.push(buildNotDeletedQuery());
  
  

  filter = [meiliJoinFilter(filter, "AND")];
  
  // console.log(JSON.stringify({
  //   filter
  // }, null, 2));

  return {
    "filter": filter,
  };
}

function buildChildrenQuery(recordStub, includeDeleted = true, deep = false) {
  console.log('childrenQuery', recordStub, includeDeleted, deep)
  assert(recordStub.ownerId, "ownerId must be specified");
  assert(recordStub.path && recordStub.name, "path and name must be specified");

  let filter = [
    meiliFilter('ownerId',recordStub.ownerId),
  ];
  let prefix = [];
  if(deep) {
    pathArr = [...recordStub.path.split("\\"), recordStub.name];
    filter.push(
      meiliFilter('pathArray', pathArr, "IN"),
    );
    prefix.push(['path', `${recordStub.path}\\${recordStub.name}`]);
  }	else {
    filter.push(meiliFilter('path', `${recordStub.path}\\${recordStub.name}`));
  }

  filter = meiliJoinFilter(filter, "AND");

  if(!includeDeleted)
    filter.push(buildNotDeletedQuery());

  return {
    "filter": filter,
    "prefix": prefix,
  };
}

function buildNotDeletedQuery() {
  return meiliFilter('isDeleted', false);
}

function indexPendingRecord(rec, update = false) {
  console.log('indexing pending record')
  return pendingIndex.addDocuments([sanitizeRecord(rec)]);

}

async function getRecord(recordStub, includePending = false, includeDeleted = true) {

  let recQueryRes = await searchRecords(buildExactRecordQuery(recordStub, includeDeleted), 1)

  let rec = recQueryRes.hits[0];

  console.log(rec)
  
  if(rec || !includePending) return rec;

  if(includePending) {
  let pendingQueryRes = await searchPendingRecords(buildExactRecordQuery(recordStub, includeDeleted), 1)

  return pendingQueryRes.hits[0];
  }

  return null;


}

async function getSomePendingRecords(size) {
  let res = await searchPendingRecords({
    q: "",
  }, size, 0);
  return res.hits;
}

function deleteRecord(recordStub) {
  recordsIndex.deleteDocuments(buildExactRecordQuery(recordStub))
}

function deletePendingRecord(recordStub) {
  pendingIndex.deleteDocuments(buildExactRecordQuery(recordStub))
}

function indexRecord(record, update = false) {
  console.log('indexing record')
  return recordsIndex.addDocuments([sanitizeRecord(record)]);
}

const maxQuerySize = 500;

async function searchRecords(query, size = 100, from = 0, index = recordsIndex) {

  

  if(typeof query.filter == 'object') {
    if(query.filter?.length > 1) {
      query.filter = meiliJoinFilter(query.filter);
    }

    if(query.filter?.length == 0) {
      delete query.filter;
    }
  } else if (typeof query.filter == 'string') {
    query.filter = [query.filter];
  }

  let prefixes = [];

  if(query.prefix) {
    prefixes = query.prefix;
    delete query.prefix;
  }

  query.limit = size;
  // query.hitsPerPage = size;
  query.offset = from;

  console.log(query);



  let queryRes = await index.search(null, query) // the search query is in the options object
    
  let hits = queryRes.hits;

  if(prefixes.length > 0) {
    for(prefix of prefixes) {
      hits = hits.filter(hit => {
        return hit[prefix[0]].startsWith(prefix[1]);
      });
    }
  }

  if(hits.length == 0) return {
    total: queryRes.estimatedTotalHits,
    max_score: 1,
    hits: [],
  };

  if(size > maxQuerySize) {
    hits = [...hits, ...(await searchRecords(query, size - maxQuerySize, from + maxQuerySize, index)).hits];
  }

    // console.log(hits)

    // console.log(query)

    return {
      total: queryRes.estimatedTotalHits,
      max_score: 1,
      hits: hits,
    };

}

async function searchPendingRecords(query, size = 10, from = 0, extraBody = {}, extraParams = {}) {
  return await searchRecords(query, size, from, pendingIndex);
}

module.exports = {
  MAX_SIZE,
  client,
  buildSearchQuery, buildChildrenQuery, buildExactRecordQuery, buildNotDeletedQuery,
  indexPendingRecord, getRecord, getSomePendingRecords, deleteRecord, deletePendingRecord, indexRecord, searchRecords, searchPendingRecords,
  meiliFilter, meiliJoinFilter, meiliMultiFilter, meiliEmpty,
};
