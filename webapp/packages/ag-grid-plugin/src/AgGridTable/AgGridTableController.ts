/*
 * cloudbeaver - Cloud Database Manager
 * Copyright (C) 2020 DBeaver Corp and others
 *
 * Licensed under the Apache License, Version 2.0.
 * you may not use this file except in compliance with the License.
 */

import {
  GridApi,
  ColumnApi,
  GridReadyEvent,
  IDatasource,
  IGetRowsParams,
  ColDef,
  ValueGetterParams,
  GridOptions,
  CellEditingStoppedEvent,
} from 'ag-grid-community';
import { RowDataTransaction } from 'ag-grid-community/dist/lib/interfaces/rowDataTransaction';
import { computed, observable } from 'mobx';

import { injectable, IInitializableController, IDestructibleController } from '@dbeaver/core/di';

import { AgGridContext } from './AgGridContext';
import {
  AgGridRow, IAgGridActions, IAgGridCol, IAgGridModel,
} from './IAgGridModel';
import { RowSelection } from './TableSelection/RowSelection';
import { TableSelection } from './TableSelection/TableSelection';

@injectable()
export class AgGridTableController implements IInitializableController, IDestructibleController {
  @observable refreshId = 0;

  private readonly datasource: IDatasource = {
    getRows: this.getRows.bind(this),
  };

  private readonly selection = new TableSelection();

  /**
   * contains properties to pass to ag-grid
   */
  private readonly context: AgGridContext = {
    selection: this.selection,
    onEditSave: this.onEditSave.bind(this),
    onEditCancel: this.onEditCancel.bind(this),
  }

  /**
   * ag-grid options that is set and not changed during AgGridComponent lifetime
   */
  private readonly gridOptions: GridOptions = {
    defaultColDef: defaultColumnDef,

    rowHeight: 24,
    headerHeight: 28,
    rowModelType: 'infinite',
    cacheBlockSize: undefined, // to be set during init phase

    datasource: this.datasource,

    context: this.context,
    // maxBlocksInCache: 1,

    onGridReady: this.handleGridReady.bind(this),
    onBodyScroll: this.handleBodyScroll.bind(this),

    onCellEditingStopped: this.handleCellEditingStopped.bind(this),
  };

  @observable columns: ColDef[] = [];

  /**
   * use this object to dynamically change ag-grid properties
   */
  @computed get dynamicOptions() {
    return {
      enableRangeSelection: !!this.selection,
    };
  }

  private api?: GridApi;
  private columnApi?: ColumnApi;
  private gridModel!: IAgGridModel;
  private resizeTask?: any;

  /**
   * this actions will be passed outside data grid to ba called
   */
  private actions: IAgGridActions = {
    changeChunkSize: this.changeChunkSize.bind(this),
    resetData: this.resetData.bind(this),
    updateCellValue: this.updateCellValue.bind(this),
    updateRowValue: this.updateRowValue.bind(this),
    getSelectedRows: this.getSelectedRows.bind(this),
  };

  init(gridModel: IAgGridModel) {
    gridModel.actions = this.actions;
    this.gridModel = gridModel;
    this.gridOptions.cacheBlockSize = gridModel.chunkSize;
    if (gridModel.initialColumns?.length) {
      this.columns = mapDataToColumns(gridModel.initialColumns);
    }
  }

  destruct(): void {
    this.gridModel.actions = null;
  }

  getGridOptions() {
    return this.gridOptions;
  }

  private refresh() {
    this.refreshId++;
  }

  /**
   * Part of Ag-grid IDataSource
   * Called by ag-grid when user scroll table and new portion of data is required
   * @param params
   */
  private async getRows(params: IGetRowsParams) {
    const {
      startRow,
      endRow,
      successCallback,
      failCallback,
    } = params;

    try {
      const length = endRow - startRow;
      const requestedData = await this.gridModel.onRequestData(startRow, length);
      // update columns only once after first data fetching
      if (!this.columns.length) {
        this.columns = mapDataToColumns(requestedData.columns || []);
      }
      successCallback(
        this.cloneRows(requestedData.rows),
        requestedData.isFullyLoaded ? startRow + requestedData.rows.length : -1 // use -1 to tell ag-grid that we have more data
      );
    } catch (e) {
      failCallback();
    }
  }

  private changeChunkSize(chunkSize: number): void {
    this.gridOptions.cacheBlockSize = chunkSize;
    // ag-grid is not able to change ca
    this.refresh();
  }

  private handleCellEditingStopped(event: CellEditingStoppedEvent) {
    if (this.gridModel.onCellEditingStopped) {
      this.gridModel.onCellEditingStopped(event.rowIndex, parseInt(event.column.getColId()), event.value);
    }
  }

  private onEditSave() {
    if (this.gridModel.onEditSave) {
      this.gridModel.onEditSave();
    }
  }

  private onEditCancel() {
    if (this.gridModel.onEditCancel) {
      this.gridModel.onEditCancel();
    }
  }

  private handleBodyScroll() {
    if (this.resizeTask !== undefined) {
      clearTimeout(this.resizeTask);
    }
    this.resizeTask = setTimeout(() => this.resizeIndexColumn(), 50);
  }

  private resizeIndexColumn() {
    if (this.columnApi) {
      this.columnApi.autoSizeColumns([INDEX_COLUMN_DEF.field!]);
    }
  }

  private handleGridReady(params: GridReadyEvent) {
    this.api = params.api;
    this.columnApi = params.columnApi;
    this.setInitialRow(this.gridModel.initialRows);
  }

  /* Actions */

  private resetData(columns?: IAgGridCol[], rows?: AgGridRow[]): void {
    this.selection.clear();
    if (this.api) {
      // only purgeInfiniteCache() doesn't work when cache is empty.
      // probably it thinks that nothing to delete - nothing to refresh
      this.api.refreshInfiniteCache(); // it will mark internal state for reload
      this.api.purgeInfiniteCache(); // it will reset internal state
      this.columns = columns ? mapDataToColumns(columns) : [];
      this.setInitialRow(rows);
    }
  }

  private setInitialRow(initialRows?: AgGridRow[]): void {
    if (!initialRows || !initialRows.length) {
      return;
    }
    const transaction: RowDataTransaction = {
      addIndex: 0,
      add: initialRows || [],
    };
    this.api!.updateRowData(transaction);
  }

  private updateCellValue(rowNumber: number, colNumber: number, value: any): void {
    if (this.api) {
      this.api
        .getRowNode(`${rowNumber}`)
        .setDataValue(`${colNumber}`, value);
    }
  }

  private updateRowValue(rowNumber: number, newRow: any[]): void {
    if (this.api) {
      this.api
        .getRowNode(`${rowNumber}`)
        .setData([...newRow]);
    }
  }

  private getSelectedRows(): RowSelection[] {
    return this.selection.getSelectedRows();
  }

  private cloneRows(rows: AgGridRow[]): AgGridRow[] {
    return rows.map(row => [...row].map(v => (v === null ? '' : v))); // TODO: temporary fix dbeaver-corp/dbeaver-web#663
  }
}

const defaultColumnDef: ColDef = {
  sortable: true,
  filter: true,
  resizable: true,
  editable: true,
  cellEditor: 'plainTextEditor',
};

export const INDEX_COLUMN_DEF: ColDef = {
  headerName: '#',
  field: `${Number.MAX_SAFE_INTEGER}`,
  valueGetter: 'node.id',
  width: 70,
  pinned: 'left',
  suppressNavigable: true,
  suppressMenu: true,
  editable: false,
  cellRenderer: row => row.rowIndex + 1,
};

function mapDataToColumns(columns: IAgGridCol[]): ColDef[] {
  if (!columns.length) {
    return [];
  }
  return [
    INDEX_COLUMN_DEF,
    ...columns.map(v => ({
      headerName: v.label,
      field: `${v.position}`,
      valueGetter: v.dataKind === 'OBJECT' ? getObjectValue : undefined,
      headerComponentParams: {
        icon: v.icon,
      },
    })),
  ];
}

function getObjectValue({ data, colDef }: ValueGetterParams) {
  return data[colDef.field || 'node.id'].value;
}
