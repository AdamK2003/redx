require("dotenv").config();

const fsPromises = require("fs/promises");
const fs = require("fs");
const path = require("path");
const _ = require("underscore");

const cloudx = require("../lib/cloudx");
const db = require("../lib/db");
const { describeRecord, describeObject, describeWorld } = require("../lib/objectdescriber");
const { recordToString, readRemotePackedObject, isRecordNewer, maybeIndexRecord, maybeIndexPendingRecord, maybeFetchAndIndexPendingRecordUri, maybeFetchAndIndexPendingRecordUris, setRecordDeleted } = require("../lib/spider-utils");
const { indexBy, backOff, promiseTry, promiseMap } = require("../lib/utils");
const { isRecordIgnored } = require("../lib/ignorelist-utils");
const roots = require("../data/roots");
const { fetchRecordCached } = require("../lib/cloudx-cache");

const CONCURRENCY = 4;
const BATCH_SIZE = 16;

async function handleLinkRecordInIgnoredDirectory(rec) {
	const targetStub = cloudx.parseRecordUri(rec.assetUri);
	if(!targetStub)
		return;
	const target = await db.getRecord(targetStub);
	if(!isRecordIgnored(target || targetStub))
		console.log(`shouldBeAlsoIgnored ${recordToString(target || targetStub)}`);
}

function handleIgnoredDirectoryRecord(rec) {
	return Promise.all([
		db.searchRecords(db.buildChildrenQuery(rec, true, true), db.MAX_SIZE).then(res => res.hits),
		db.searchPendingRecords(db.buildChildrenQuery(rec, true, true), db.MAX_SIZE).then(res => res.hits),
	]).then(([localChildren, localPendingChildren]) => {
		return Promise.all([
			...localChildren.map(child => {
				console.log(`indexDirectoryRecord ${recordToString(rec)} ignored removed child ${recordToString(child)}`);
				return setRecordDeleted(child).then(() => {
					if(child.recordType === "link")
						return handleLinkRecordInIgnoredDirectory(child);
				});
			}),
			...localPendingChildren.map(child => {
				console.log(`indexDirectoryRecord ${recordToString(rec)} ignored removed pending child ${recordToString(child)}`);
				return deletePendingRecord(child, true);
			})
		]);
	}).then(() => {
		return setRecordDeleted(rec);
	});
}

function handleDeletedDirectoryRecord(rec, localChildren, localPendingChildren) {
	return Promise.all([
		...localChildren.map(child => {
			console.log(`indexDirectoryRecord ${recordToString(rec)} deleted removed child ${recordToString(child)}`);
			return setRecordDeleted(child);
		}),
		...localPendingChildren.map(child => {
			if(child.recordType === "directory") // don't delete pending child directories, in case they were moved somewhere else
				return;
			console.log(`indexDirectoryRecord ${recordToString(rec)} deleted removed pending child ${recordToString(child)}`);
			return deletePendingRecord(child, true);
		})
	]).then(() => {
		return setRecordDeleted(rec);
	});
}

async function indexDirectoryRecord(rec) {
	console.log('indexDirectoryRecord', rec);
	if(isRecordIgnored(rec)) {
		// delete all indexed children and then itself
		console.log(`indexDirectoryRecord ${recordToString(rec)} ignored`);
		return handleIgnoredDirectoryRecord(rec);
	}

	maybeIndexRecord(rec);

	let isRecordDeleted = false;
	const [apiChildren, localChildren, localPendingChildren] = await Promise.all([
		cloudx.fetchDirectoryChildren(rec).catch(err => {
			if (cloudx.isPermanentHttpError(err)) {
				console.log(`indexDirectoryRecord ${recordToString(rec)} http error ${err.message || err}`);
				isRecordDeleted = true;
				return [];
			}
			throw err;
		}),
		await db.searchRecords(db.buildChildrenQuery(rec), db.MAX_SIZE).then(res => res.hits),
		await db.searchPendingRecords(db.buildChildrenQuery(rec), db.MAX_SIZE).then(res_1 => res_1.hits),
	]);
	if (isRecordDeleted) {
		console.log(`indexDirectoryRecord ${recordToString(rec)} deleted`);
		return handleDeletedDirectoryRecord(localChildren, localPendingChildren);
	}
	if (apiChildren.some(child => child.name === ".noindex")) {
		console.log(`indexDirectoryRecord ${recordToString(rec)} .noindex`);
		return handleIgnoredDirectoryRecord(rec);
	}
	const apiChildrenById = indexBy(apiChildren, "id");
	const localChildrenById = indexBy(localChildren, "id");
	const localPendingChildrenById = indexBy(localPendingChildren, "id");
	await Promise.all([
		...apiChildren.map(child_1 => {
			if (localPendingChildrenById.has(child_1.id))
				return;
			if (localChildrenById.has(child_1.id) && !isRecordNewer(child_1, localChildrenById.get(child_1.id)))
				return;
			if (isRecordIgnored(child_1))
				return;
			console.log(`indexDirectoryRecord ${recordToString(rec)} added/updated child ${recordToString(child_1)}`);
			return db.indexPendingRecord(child_1, true);
		}), // index new records as pending
		...localChildren.map(child_2 => {
			if (apiChildrenById.has(child_2.id))
				return;
			console.log(`indexDirectoryRecord ${recordToString(rec)} removed child ${recordToString(child_2)}`);
			return setRecordDeleted(child_2);
		}),
		...localPendingChildren.map(child_3 => {
			if (apiChildrenById.has(child_3.id))
				return;

			console.log(`indexDirectoryRecord ${recordToString(rec)} removed pending child ${recordToString(child_3)}`);
			return deletePendingRecord(child_3, true);
		}),
	]);
	
}

async function indexLinkRecord(rec) {
	if(isRecordIgnored(rec))
		return setRecordDeleted(rec);

	await maybeFetchAndIndexPendingRecordUri(rec.assetUri);
	await maybeIndexRecord(rec);
}

async function indexObjectRecord(rec) {
	console.log('indexObjectRecord', recordToString(rec));
	if(isRecordIgnored(rec))
		return setRecordDeleted(rec);

	let desc = describeRecord(rec), describedRec = rec;
	console.log(desc);

	if(desc.worldUri)
		console.log(`indexObjectRecord ${recordToString(rec)} worldUri ${desc.worldUri}`);
		await maybeFetchAndIndexPendingRecordUri(desc.worldUri);

	if(desc.objectType) { // have enough info in record
		console.log(`indexObjectRecord ${recordToString(rec)} description`, desc);
		describedRec = _.extend(rec, desc);
	} else {
		const obj = await readRemotePackedObject(rec.assetUri);
		if(obj) {
			const desc = describeObject(obj);
			console.log(`indexObjectRecord ${recordToString(rec)} description`, desc);
			describedRec = _.extend(rec, desc);
		}
	}

	

	await maybeIndexRecord(describedRec);
}

async function indexWorldRecord(rec) {
	console.log('indexWorldRecord', recordToString(rec));
	if(isRecordIgnored(rec))
		return setRecordDeleted(rec);

	let describedRec = rec;
	const obj = await readRemotePackedObject(rec.assetUri);
	if(obj) {
		const desc = describeWorld(obj);
		console.log(`indexWorldRecord ${recordToString(rec)} description`, desc);
		describedRec = _.extend(rec, desc);
	}

	await maybeIndexRecord(describedRec);
}

async function indexGenericRecord(rec) {
	if(isRecordIgnored(rec))
		return setRecordDeleted(rec);

	await maybeIndexRecord(rec);
}

async function deletePendingRecord(rec, wait = false) {
	const uri = cloudx.getRecordUri(rec);
	if(deletedPendingRecordsThisLoop.has(uri)) {
		console.log(`deletePendingRecord ${recordToString(rec)} already deleted`);
		return false;
	}

	deletedPendingRecordsThisLoop.add(uri);
	await db.deletePendingRecord(rec, wait);
	return true;
}

// let indexedRecordsCache = new Set;
let deletedPendingRecordsThisLoop;

async function indexPendingRecords() {
	console.log("indexPendingRecords");
	await db.waitForTasks({
		indexes: ["pending"]
	})
	const records = await db.getSomePendingRecords(BATCH_SIZE)
	if(!records.length)
		return;

	deletedPendingRecordsThisLoop = new Set;

	// deduplicate records to prevent elastic race condition
	const recordsByUri = indexBy(records, rec => cloudx.getRecordUri(rec));
	const dedupedRecords = Array.from(recordsByUri.values());

	await promiseMap(dedupedRecords, rec => {
		const uri = cloudx.getRecordUri(rec);
		if(deletedPendingRecordsThisLoop.has(uri)) {
			console.log(`processPendingRecord ${recordToString(rec)} skipped already deleted pending record`);
			return;
		}

		return backOff(async () => {
			console.log(`processPendingRecord ${recordToString(rec)}`);
			if(rec.recordType === "directory")
				return await indexDirectoryRecord(rec);
			if(rec.recordType === "link")
				return await indexLinkRecord(rec);
			if(rec.recordType === "object")
				return await indexObjectRecord(rec);
			if(rec.recordType === "world")
				return await indexWorldRecord(rec);
			return await indexGenericRecord(rec);
		}).then(async () => {
			return await deletePendingRecord(rec, true);
		});
	}, CONCURRENCY);

	return indexPendingRecords();
}

async function getAllDirectoryRecords(inclDeleted = false) {
	let filter = [
	"(recordType = 'directory')",
	];
	if(!inclDeleted)
		filter = db.meiliJoinFilter([filter, db.meiliFilter('isDeleted', false)], 'AND');

	const res = await db.getFilteredRecords({
		filter: filter,
	}, Infinity, 0);

	return res.hits;
}

async function deleteIgnoredDirectories() {
	const records = await getAllDirectoryRecords();

	return promiseMap(records, rec => {
		if(isRecordIgnored(rec)) {
			console.log(`deleteIgnoredDirectories ${recordToString(rec)}`);
			return handleIgnoredDirectoryRecord(rec);
		}
	});
}

async function rescan() {
	const [records, pendingRecords] = await Promise.all([
		getAllDirectoryRecords(),
		db.getFilteredPendingRecords({
			filter: "(recordType = 'directory')"
		}, Infinity).then(res => res.hits)
	]);
	console.log(`rescan ${records.length} records, ${pendingRecords.length} pending records`);

	let pendingRecordsByUri = new Set;
	for(let rec of pendingRecords)
		pendingRecordsByUri.add(cloudx.getRecordUri(rec));

	let count = 0;
	await promiseMap(records, rec => {
		let uri = cloudx.getRecordUri(rec);
		if(pendingRecordsByUri.has(uri))
			return;
		pendingRecordsByUri.add(uri); // prevent adding more dupes
		count++;
		return db.indexPendingRecord(rec, true);
	});
	console.log(`rescan added ${count} pending directory records`);
}

const action = process.argv[2];
async function asyncMain() {
	if(action === "deleteIgnoredDirectories")
		return deleteIgnoredDirectories();

	await maybeFetchAndIndexPendingRecordUris(roots, CONCURRENCY);

	if(action === "index") {
		const recordStub = process.argv[3] && cloudx.parseRecordUri(process.argv[3]);
		if(!recordStub) {
			console.error("Usage: spider.js index RECORD_URI");
			process.exit(1);
		}
		const record = await fetchRecordCached(recordStub);
		if(!record)
			throw new Error(`Record ${getRecordUri(recordStub)} not found.`);

		console.log(`index ${recordToString(record)}`);
		await db.indexPendingRecord(record, true);
	} else if(action === "rescan") {
		await rescan();
	}

	await indexPendingRecords();
}

asyncMain().then(() => {
	console.log("done");
	process.exit(0);
}).catch(err => {
	console.error(err.stack || err);
	process.exit(1);
});
