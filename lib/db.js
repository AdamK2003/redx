const _ = require("underscore");
const { MeiliSearch } = require("meilisearch");
const assert = require("assert");
const { raw } = require("express");

const meiliClient = new MeiliSearch({
  host: process.env.MEILI_ENDPOINT,
  apiKey: process.env.MEILI_API_KEY
});


let indexes = {
  pending: 'redx-pending-records-res',
  records: 'redx-records-res',
};





let pendingIndex = meiliClient.index(indexes.pending);
let recordsIndex = meiliClient.index(indexes.records);


const MAX_SIZE = 1000;



async function init() { // first time setup
  console.log('Initializing database')

  await meiliClient.createIndex(indexes.pending, {
    primaryKey: 'id',
  }).catch(err => {
    console.log('Failed to create pending index')
    console.log(err)
  });

  await meiliClient.createIndex(indexes.records, {
    primaryKey: 'id',
  }).catch(err => {
    console.log('Failed to create records index')
    console.log(err)
  });

  let pendingIndex = meiliClient.index("redx-pending-records-res");
  let recordsIndex = meiliClient.index("redx-records-res");

  let indexes = [pendingIndex, recordsIndex];

  // set filterable attributes

  await indexes.forEach(async (index) => {
    index.updateFilterableAttributes([
      "id",
      "isDeleted",
      "isForPatrons",
      "isListed",
      "isPublic",
      "name",
      "objectType",
      "ownerId",
      "ownerName",
      "path",
      "recordType",
      "tags",
      "version",
    ])})

  // set searchable attributes

  await indexes.forEach(async (index) => {
    index.updateSearchableAttributes([
      "pathNameSearchable",
      "ownerPathNameSearchable",
      "tagsSearchable",
      "name",
      "simpleName",
      "recordType",
      "ownerName",
      "tags",
      "path",
    ])})

  // set sortable attributes

  await indexes.forEach(async (index) => {
    index.updateSortableAttributes([
      "lastModificationTime",
      "creationTime",
    ])})

  // set ranking rules

  await indexes.forEach(async (index) => {
    index.updateRankingRules([
      "typo",
      "words",
      "proximity",
      "attribute",
      "sort",
      "exactness",
      "lastModificationTime:desc",
      "creationTime:desc",
    ])})

}



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

const emptyFilter = meiliJoinFilter(meiliMultiFilter('recordType', ['directory', 'object']), "OR");

function buildSearchQuery(q, types, where = ['simpleName', 'ownerName', 'pathNameSearchable', 'tagsSearchable'], includeDeleted = true, rawFilters = [], rawFiltersJoiner = "AND", strict = true) {

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

  let filters = [];

  if(recordTypes.length > 0) {
    filters.push(meiliJoinFilter(meiliMultiFilter('recordType', recordTypes, '=', strict), 'OR'));
  }

  if(objectTypes.length > 0) {
    filters.push(meiliJoinFilter(meiliMultiFilter('objectType', objectTypes, '=', strict), 'OR'));
  }

  if(recordTypes.length == 0 && objectTypes.length == 0) {
    filters.push(emptyFilter);
  }




  let filter = [
    meiliJoinFilter(filters, 'OR'),
  ];

  if(rawFilters?.length > 0) {
    filter.push(meiliJoinFilter(rawFilters, rawFiltersJoiner));
    filter = [meiliJoinFilter(filter, "AND")];
  }

  // if(q == "" || !q) {
  //   res.sort = [
  //     'lastModificationTime:desc',
  //     'creationTime:desc',
  //   ]
  // }


  
  if(!includeDeleted) filter = meiliJoinFilter([filter, buildNotDeletedQuery()], "AND");
  
  // console.log(filter)
  res.q = q;
  res.filter = filter;

  if(where) {
    res.attributesToSearchOn = where;
  }


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
  console.log('childrenQuery', recordStub.id, includeDeleted, deep)
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



async function getRecord(recordStub, includePending = false, includeDeleted = true) {

  let recQueryRes = await searchRecords(buildExactRecordQuery(recordStub, includeDeleted), 1)

  let rec = recQueryRes.hits[0];

  // console.log(rec)
  
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

async function deleteRecord(recordStub, wait = false) {
  let task = await recordsIndex.deleteDocuments(buildExactRecordQuery(recordStub))
  // console.log(task)

  // if wait is true, wait for the task to be processed

  if(wait) {
    while(true) {
      let taskRes = await meiliClient.getTask(task.taskUid);
      if(taskRes.status == "succeeded") {
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

async function deletePendingRecord(recordStub, wait = false) {
  let task = await pendingIndex.deleteDocuments(buildExactRecordQuery(recordStub))
  // console.log(task)

  // if wait is true, wait for the task to be processed

  if(wait) {
    while(true) {
      let taskRes = await meiliClient.getTask(task.taskUid);
      // console.log(taskRes)
      if(taskRes.status == "succeeded") {
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }


}

const maxBatchSize = 5000

let recordsToIndex = [];
let recordCount = 0;
let recordTimeout = false;
let pendingRecordsToIndex = [];
let pendingRecordCount = 0;
let pendingRecordTimeout = false;

function indexRecord(record, commitNow = false) {
  console.log('db: indexing record')

  return recordsIndex.addDocuments([sanitizeRecord(record)]);
  if(record) {
    recordsToIndex.push(sanitizeRecord(record));
    recordCount++;
  }

  if(commitNow || recordCount > maxBatchSize) {
    commitRecords();
  } else if(!recordTimeout && record) {
    setTimeout(commitRecords, 15 * 1000);
    recordTimeout = true;
  }

}

async function commitRecords() {
  console.log('db: committing records')
  recordTimeout = false;
  if(recordsToIndex) {
    recordsIndex.addDocuments(recordsToIndex);
    recordsToIndex = [];
  }
}

function indexPendingRecord(record, commitNow = false) {
  console.log('db: indexing pending record')

  return pendingIndex.addDocuments([sanitizeRecord(record)]);
  pendingRecordsToIndex.push(sanitizeRecord(record));
  pendingRecordCount++;

  if(commitNow || pendingRecordCount > maxBatchSize) {
    commitPendingRecords();
  } else if(!pendingRecordTimeout && record) {
    setTimeout(commitPendingRecords, 15 * 1000);
    pendingRecordTimeout = true;
  }

}

function commitPendingRecords() {
  console.log('db: committing pending records')
  pendingRecordTimeout = false;
  if(pendingRecordsToIndex) {
    pendingIndex.addDocuments(pendingRecordsToIndex);
    pendingRecordsToIndex = [];
  }
}

const maxQuerySize = 1000;

async function searchRecords(query, size = 100, from = 0, index = recordsIndex) {

  if(typeof query.filter == 'object') {
    if(query.filter?.length > 1) {
      query.filter = meiliJoinFilter(query.filter);
    } else if(query.filter?.length == 0) {
      delete query.filter;
    } else if(query.filter?.length == 1) {
      query.filter = query.filter[0];
    }


  }

  
  if(!query.matchingStrategy) query.matchingStrategy = "all";
  
  let prefixes = [];
  
  if(query.prefix) {
    prefixes = query.prefix;
    delete query.prefix;
  }
  
  query.limit = size;
  if(!query.limit) delete query.limit;
  query.offset = from;
  
  
  
  // console.log(JSON.stringify(query, null, 2))
  
  if(!query.q || query.q == "") {
    return getFilteredRecords(query, size, from, index);
  }

  if(query.limit == Infinity) query.limit = maxQuerySize;
  
  let queryRes = await index.search(null, query) // the search query is in the options object
    
  let hits = queryRes.hits;

  if(prefixes.length > 0) {
    for(let prefix of prefixes) {
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

  if(size > maxQuerySize && hits.length >= maxQuerySize) {
    hits = [...hits, ...(await searchRecords(query, size - maxQuerySize, from + maxQuerySize, index)).hits];
  }

  // console.log('hits', hits.length, hits[0])

  console.log(hits.length, 'hits')

  return {
    total: queryRes.estimatedTotalHits,
    max_score: 1,
    hits: hits,
  };

}

async function searchPendingRecords(query, size = 100, from = 0) {
  return await searchRecords(query, size, from, pendingIndex);
}

async function waitForTasks(params) { // blocks until all matching tasks are completed

  console.log('waiting for tasks to complete', params)

  let indexesFilter = [];
  if(params.indexes) {
    for(let index of params.indexes) {
      if(indexes[index]) indexesFilter.push(indexes[index]);
    }
  }

  let statuses = params.statuses || ['enqueued', 'processing'];
  let types = params.types || ['documentAdditionOrUpdate', 'documentDeletion']
  indexesFilter = indexesFilter || [indexes['pending'], indexes['records']];
  let taskIds = params.taskIds || null;

  let filter = {
    statuses: statuses,
    types: types,
    indexUids: indexesFilter,
    uids: taskIds,
  };

  while(true) {
    let tasks = await meiliClient.getTasks(filter);
    if(tasks.total == 0) break;

    console.log(tasks.total, 'tasks remaining')



    await new Promise(r => setTimeout(r, 500));

  }

  console.log('tasks completed')

}

async function getFilteredRecords(query, size = 100, from = 0, index = recordsIndex) {

  console.log('getFilteredRecords', size, from)





  if(typeof query.filter == 'object') {
    if(query.filter?.length > 1) {
      query.filter = meiliJoinFilter(query.filter);
    } else if(query.filter?.length == 0) {
      delete query.filter;
    } else if(query.filter?.length == 1) {
      query.filter = query.filter[0];
    }


  }

  let isInf = query.limit == Infinity;
  
  let prefixes = [];
  
  if(query.prefix) {
    prefixes = query.prefix;
    delete query.prefix;
  }
  

  if(query.q) {
    delete query.q;
  }

  query.limit = size;
  if(!query.limit) delete query.limit;
  if(query.limit == Infinity) query.limit = maxQuerySize;
  query.offset = from;


  // console.log(query)

  let realQuery = {
    offset: query.offset,
    limit: query.limit,
    filter: query.filter || [],
    fields: query.fields || null,
  }

  // console.log(JSON.stringify(query, null, 2))

  let queryRes = await index.getDocuments(realQuery) // the search query is in the options object
  
  let hits = queryRes.results;

  if(prefixes.length > 0) {
    for(let prefix of prefixes) {
      hits = hits.filter(hit => {
        return hit[prefix[0]].startsWith(prefix[1]);
      });
    }
  }

  if(hits.length == 0) return {
    total: queryRes.total,
    max_score: 1,
    hits: [],
  };

  if(size > maxQuerySize && hits.length >= maxQuerySize) {
    let nextHits = await getFilteredRecords(query, size - maxQuerySize, from + maxQuerySize, index);
    hits = [...hits, ...nextHits.hits];
  }

  console.log('hits', hits.length)

  // console.log(hits.length, 'hits')

  return {
    total: isInf ? hits.length : queryRes.total,
    max_score: 1,
    hits: hits,
  };

}

async function getFilteredPendingRecords(query, size = 100, from = 0) {
  return await getFilteredRecords(query, size, from, pendingIndex);
}

module.exports = {
  MAX_SIZE,
  init,
  buildSearchQuery, buildChildrenQuery, buildExactRecordQuery, buildNotDeletedQuery,
  indexPendingRecord, getRecord, getSomePendingRecords, deleteRecord, deletePendingRecord, indexRecord,
  searchRecords, searchPendingRecords, getFilteredRecords, getFilteredPendingRecords,
  meiliFilter, meiliJoinFilter, meiliMultiFilter, meiliEmpty,
  waitForTasks,
};
