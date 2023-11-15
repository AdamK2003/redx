const _ = require("underscore");
const { MeiliSearch } = require("meilisearch");
const assert = require("assert");

const meiliClient = new MeiliSearch({
  host: process.env.MEILI_ENDPOINT,
  apiKey: process.env.MEILI_API_KEY
});



const client = { // stub
  deleteByQuery: () => Promise.resolve(),
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

  console.log(JSON.stringify(rec, null, 2));

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
  if(strict && values.length == 0) {
    filters.push(meiliEmpty(attribute));
    return filters;
  }
  for(let value of values)
    filters.push(meiliFilter(attribute, value, filterType));
  // console.log(filters)
  return filters;
}

function meiliJoinFilter(filters, joiner = "OR") {
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
  // console.log(out)
  return out;
}

function buildSearchQuery(q, types, where = ["*"], includeDeleted = true) {

  // console.log(types)

  let recordTypes = [], objectTypes = [];
	for(let t of types) {
		if(["directory", "link", "object", "world"].includes(t))
			recordTypes.push(String(t));
		else
			objectTypes.push(String(t));
	}

  // console.log(recordTypes)
  // console.log(objectTypes)
  // console.log(meiliJoinFilter(meiliMultiFilter('recordType', recordTypes)))

  const filter = [
    meiliJoinFilter([meiliJoinFilter(meiliMultiFilter('recordType', recordTypes, '=', true)),
    meiliJoinFilter(meiliMultiFilter('objectType', objectTypes, '=', true))], recordTypes.length > 0 && objectTypes.length > 0 ? "OR" : "AND"),
  ];

  // console.log(filter)


  if(!includeDeleted)
    filter.push(buildNotDeletedQuery());

  return {
    "q": q,
    "filter": filter,
    // "attributesToSearchOn": where,
  };
}

function buildExactRecordQuery(recordStub, includeDeleted = true) {
  assert(recordStub.ownerId, "ownerId must be specified");
  assert(recordStub.id || (recordStub.path && recordStub.name), "either id or both path and name must be specified");

  const filter = [
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

  console.log(filter)

  if(!includeDeleted)
    filter.push(buildNotDeletedQuery());

  console.log(JSON.stringify({
    filter
  }, null, 2));

  return {
    "filter": filter,
  };
}

function buildChildrenQuery(recordStub, includeDeleted = true, deep = false) {
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
    prefix.push({'path': `${recordStub.path}\\${recordStub.name}`});
  }	else {
    filter.push(meiliFilter('path', `${recordStub.path}\\${recordStub.name}`));
  }

  if(!includeDeleted)
    filter.push(buildNotDeletedQuery());

  return {
    "filter": filter,
  };
}

function buildNotDeletedQuery() {
  return meiliFilter('deleted', false);
}

function indexPendingRecord(rec) {
  return pendingIndex.addDocuments([sanitizeRecord(rec)]);

}

async function getRecord(recordStub, includePending = false, includeDeleted = true) {
  console.log(recordStub)
  let recQueryRes = await searchRecords(buildExactRecordQuery(recordStub, includeDeleted), size = 1, from = 0, index = recordsIndex)


  
    then(getHits).then(_.first).then(rec => {
    if(rec || !includePending)
      return rec;

    return client.search({
      index: PENDING_RECORDS_IDX,
      body: {
        query: buildExactRecordQuery(recordStub, includeDeleted)
      }
    }).then(getHits).then(_.first);
  });
}

function getSomePendingRecords(size) {
  return client.search({
    index: PENDING_RECORDS_IDX,
    body: {
      query: {
        match_all: {}
        // terms: { recordType: ["world"] }
        // terms: { recordType: ["link","directory","world"] }
        // terms: { recordType: ["object"] }
      },
      size
    }
  }).then(getHits);
}

function deleteRecord(recordStub) { // implement soft delete flag
  return client.deleteByQuery({
    index: RECORDS_IDX,
    refresh: true,
    body: {
      query: buildExactRecordQuery(recordStub),
    }
  });
}

function deletePendingRecord(recordStub) { // implement soft delete flag
  return client.deleteByQuery({
    index: PENDING_RECORDS_IDX,
    refresh: true,
    body: {
      query: buildExactRecordQuery(recordStub),
    }
  });
}

function indexRecord(record) {
  return recordsIndex.addDocuments([sanitizeRecord(record)]);
  // return client.index({
  // 	index: RECORDS_IDX,
  // 	body: sanitizeRecord(record)
  // });
}


async function searchRecords(query, size = 10, from = 0, index = pendingIndex) {

  
  // console.log(extraBody);
  // console.log(extraParams);

  // if(size > MAX_SIZE)
  //   return searchRecordsPit(query, size, from, extraBody, extraParams);


  // return client.search({
  //   index: RECORDS_IDX,
  //   body: {
  //     query,
  //     size, from,
  //     ...extraBody
  //   },
  //   ...extraParams
  // })
  

  if(query.filter.length > 1) {
    query.filter = meiliJoinFilter(query.filter);
  }

  if(query.filter.length == 0) {
    delete query.filter;
  }

  // console.log(JSON.stringify(query, null, 2));


  let queryRes = await index.search(null, query) // the search query is in the options object
    
    // console.log(queryRes)
    const hits = queryRes.hits;
    // console.log(hits)
    return {
      total: queryRes.estimatedTotalHits,
      max_score: 1,
      hits: hits,
    };

}

function searchPendingRecords(query, size = 10, from = 0, extraBody = {}, extraParams = {}) {
  return searchRecords(query, size, from, pendingIndex);
}

module.exports = {
  MAX_SIZE,
  client,
  buildSearchQuery, buildChildrenQuery, buildExactRecordQuery, buildNotDeletedQuery,
  indexPendingRecord, getRecord, getSomePendingRecords, deleteRecord, deletePendingRecord, indexRecord, searchRecords, searchPendingRecords
};
