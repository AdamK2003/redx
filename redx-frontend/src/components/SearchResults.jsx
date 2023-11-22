import { CopyOutlined, FolderOutlined, FrownOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { Button, Drawer, Empty, Pagination, Row, Tooltip } from "antd";
import classNames from "classnames";
import { useCallback, useEffect, useRef, useState } from "react";
import { typeOptions } from "../lib/constants";
import { resolveThumbnailUri, stripRichText, useCopyHelper } from "../lib/utils";
import "./SearchResults.css";

function RecordThumbnail({ thumbnailUri, name }) {
	let [error, setError] = useState(false);

	return error ? <FrownOutlined className="Record-icon" style={{ fontSize: 32 }} /> : (
		<div className="Record-thumbnail">
			<img src={resolveThumbnailUri(thumbnailUri)} alt={stripRichText(name)} onError={e => setError(true)} />
		</div>
	);
}

function Record({ record, onShowRecordInfoClick }) {
	let recordOrAssetUri = record.assetUri || `resrec:///${record.ownerId}/${record.id}`;

	let [copyHelper, copy] = useCopyHelper(recordOrAssetUri);

	let className = ["Record", "--record-type-" + record.recordType, "--type-" + record.type].join(" ");

	return (<div className={className} title={stripRichText(record.name)}>
		{record.thumbnailUri && <RecordThumbnail name={record.name} thumbnailUri={record.thumbnailUri} />}
		{record.type === "directory" && <FolderOutlined className="Record-icon" style={{ fontSize: 32 }} />}
		<div className="Record-name">{stripRichText(record.name)}</div>
		<div className="Record-actions --right">
			<Tooltip title="Copy assetUri"><button type="button" onClick={e => copy()}><CopyOutlined /></button></Tooltip>
		</div>
		<div className="Record-actions --left">
			<Tooltip title="Record Info"><button type="button" onClick={onShowRecordInfoClick}><InfoCircleOutlined /></button></Tooltip>
		</div>
		{copyHelper}
	</div>);
}

function RecordInfoItem({ title, content, className }) {
	return (
		<div className={classNames("RecordInfoItem", className)}>
			<div className="RecordInfoItem-title">{title}:</div>
			<div className="RecordInfoItem-content">{content}</div>
		</div>
	);
}

function RecordInfo({ record }) {
	console.log(record)


	let assetUrls = [];
	if(record.recordType === "object") {
		for (let type of ['asset', 'thumbnail', 'texture']) {
			if (record[type + 'Uri']) {
				let assetType = type
				let assetUri = record[type + 'Uri']
				// console.log(assetUri)
				let assetId = assetUri.split("/").pop().split(".")[0]
				let assetExt = assetUri.split(".").pop()
				let assetDirectUrl = assetUri.startsWith("http") ? assetUri : undefined
				// console.log(assetDirectUrl)

				assetUrls.push({
					type: assetType,
					uri: assetUri,
					id: assetId,
					ext: assetExt,
					directUrl: assetDirectUrl,
				})
			}
		}

		for (let tag of record.tags) {
			if(['raw_file_asset', 'clip_asset'].includes(tag.split(":")[0])) {
				let assetType = tag.split(":")[0].split("_").slice(0, -1).join("_");
				let assetUri = tag.split(":").slice(1).join(":");
				// console.log(assetUri)
				let assetId = assetUri.split("/").pop().split(".")[0];
				let assetExt = assetUri.split(".")[1] || undefined;
				if(assetType == 'texture') assetExt = 'image';
				let assetDirectUrl = assetUri.startsWith("http") ? assetUri : undefined;

				assetUrls.push({
					type: assetType,
					uri: assetUri,
					id: assetId,
					ext: assetExt,
					directUrl: assetDirectUrl,
				})
			}
		}
	}

	let [copyHelper, copy] = useCopyHelper();

	let copyParentUri = useCallback((depth) => {
		copy(record.spawnParentUri + "&depth=" + depth);
	}, [copy, record.spawnParentUri]);

	let pathItems = record.path.split("\\").slice(1).map((name, i) => (
		<Button className="RecordInfo-pathItem" key={i} size="small" onClick={e => copyParentUri(i + 1)}>{stripRichText(name)}</Button>
	));

	

	let recordTypeName = record.type;
	for (let o of typeOptions)
		if (o.value === record.type)
			recordTypeName = o.label;

	return (
		<div className="RecordInfo">
			<RecordInfoItem title="Name" content={stripRichText(record.name)} />
			<RecordInfoItem title="Owner" content={stripRichText(record.ownerName)} />
			<RecordInfoItem title="Category" content={recordTypeName} />
			<RecordInfoItem className="--path" title={
				<>
					Path <span>(click to copy spawnUri)</span>
				</>
			} content={pathItems} />
			{record.thumbnailUri && <RecordInfoItem title="Thumbnail" content={
				<RecordThumbnail name={record.name} thumbnailUri={record.thumbnailUri} />
			} />}
			{/* <RecordInfoItem title="Created" content={record.creationTime} /> */}
			{/* <RecordInfoItem title="Modified" content={record.lastModificationTime} /> */}
			<RecordInfoItem title="Tags" content={record.tags.join(', ')} />
			<RecordInfoItem className="--path" title={
				<>
					Assets <span>(label is asset type)</span>
				</>
			} content={assetUrls.map(o => (
				<div className="RecordInfo-assetUri">
					<a
						// size="medium" 
						href={o.directUrl ? o.directUrl : `/asset/${o.id}${(o.ext&&o.ext!='image')?`?format=${o.ext}`:''}`}
						target="_blank"
					>
						{o.type + (o.directUrl ? ' (url)' : (o.ext?` (${o.ext})`:''))}
					</a>
				</div>
			))} />
			{copyHelper}
		</div>
	);
}

// const pageSizeOptions = [ 10, 50, 100 ];

function SearchResults({ res, pagination: { from, size }, onPaginationChange }) {
	let { hits, total } = res;
	let [infoRecord, setInfoRecord] = useState(null);
	let [recordsInRow, setRecordsInRow] = useState(10);

	let hitsRef = useRef(null);
	const handleWindowResize = useCallback(() => {
		if (!hitsRef.current)
			return;
		let newRecordsInRow = Math.floor((hitsRef.current.clientWidth + 5) / (120 + 5));
		if (recordsInRow !== newRecordsInRow)
			setRecordsInRow(newRecordsInRow);
		if (size % newRecordsInRow !== 0)
			onPaginationChange({
				from, size: Math.min(
					Math.floor(100 / newRecordsInRow) * newRecordsInRow,
					Math.ceil(size / newRecordsInRow) * newRecordsInRow
				)
			});
	}, [hitsRef, recordsInRow, setRecordsInRow, from]);
	useEffect(() => {
		window.addEventListener("resize", handleWindowResize);
		return () => {
			window.removeEventListener("resize", handleWindowResize);
		};
	}, [handleWindowResize]);

	let pageSizeOptions = [recordsInRow * 2, Math.floor(50 / recordsInRow) * recordsInRow, Math.floor(100 / recordsInRow) * recordsInRow];

	if (!total)
		return (
			<div className="SearchResults --empty">
				<Empty />
			</div>
		);

	return (
		<div className="SearchResults">
			<div className="SearchResults-hits" ref={hitsRef}>
				{hits.map(hit => (
					<Record record={hit} key={hit.id} onShowRecordInfoClick={() => setInfoRecord(hit)} />
				))}
			</div>

			<Row justify="center">
				<Pagination
					total={total}
					pageSize={size}
					pageSizeOptions={pageSizeOptions}
					current={Math.floor(from / size) + 1}
					onChange={(page, pageSize) => onPaginationChange({ from: (page - 1) * pageSize, size: pageSize })}
				/>
			</Row>

			<Drawer title="Record Info" placement="right" onClose={e => setInfoRecord(null)} visible={infoRecord !== null}>
				{infoRecord && <RecordInfo record={infoRecord} />}
			</Drawer>
		</div>
	);
}

export default SearchResults;
