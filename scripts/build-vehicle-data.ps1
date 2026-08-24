[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SourceWorkbook,
  [string]$OutputPath = '',
  [string]$SheetName = ([string]::Concat([char]0x5173, [char]0x8054, [char]0x4EF6, [char]0x7BA1, [char]0x7406)),
  [int]$HeaderRow = 2
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Normalize-Text {
  param([AllowNull()][object]$Value)
  if ($null -eq $Value) { return '' }
  return ([string]$Value).Replace("`r`n", "`n").Replace("`r", "`n").Trim()
}

function Read-ZipEntryText {
  param(
    [Parameter(Mandatory = $true)][System.IO.Compression.ZipArchive]$Archive,
    [Parameter(Mandatory = $true)][string]$EntryName
  )
  $entry = $Archive.GetEntry($EntryName)
  if (-not $entry) { return $null }
  $reader = [System.IO.StreamReader]::new($entry.Open())
  try {
    return $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
  }
}

function New-XmlNamespaceManager {
  param([Parameter(Mandatory = $true)][xml]$Document)
  $manager = [System.Xml.XmlNamespaceManager]::new($Document.NameTable)
  $manager.AddNamespace('x', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
  return ,$manager
}

function Get-RichText {
  param(
    [Parameter(Mandatory = $true)][System.Xml.XmlNode]$Node,
    [Parameter(Mandatory = $true)][System.Xml.XmlNamespaceManager]$NamespaceManager
  )
  return (($Node.SelectNodes('.//x:t', $NamespaceManager) | ForEach-Object { $_.InnerText }) -join '')
}

function Convert-ColumnReferenceToIndex {
  param([Parameter(Mandatory = $true)][string]$Reference)
  $letters = [regex]::Match($Reference, '^[A-Z]+').Value
  if (-not $letters) { return -1 }
  $index = 0
  foreach ($letter in $letters.ToCharArray()) {
    $index = $index * 26 + ([int][char]$letter - [int][char]'A' + 1)
  }
  return $index - 1
}

function Convert-ColumnIndexToLetters {
  param([Parameter(Mandatory = $true)][int]$ColumnIndex)
  $value = $ColumnIndex + 1
  $letters = ''
  while ($value -gt 0) {
    $remainder = ($value - 1) % 26
    $letters = [char]([int][char]'A' + $remainder) + $letters
    $value = [math]::Floor(($value - 1) / 26)
  }
  return $letters
}

function Get-CellText {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Cells,
    [Parameter(Mandatory = $true)][int]$ColumnIndex
  )
  if ($Cells.ContainsKey($ColumnIndex)) { return (Normalize-Text $Cells[$ColumnIndex]) }
  return ''
}

$resolvedWorkbook = (Resolve-Path -LiteralPath $SourceWorkbook).Path
if ([System.IO.Path]::GetExtension($resolvedWorkbook).ToLowerInvariant() -ne '.xlsx') {
  throw 'SourceWorkbook must be an .xlsx file.'
}

if (-not $OutputPath) {
  $OutputPath = Join-Path $PSScriptRoot '..\data\vehicle-components.local.json'
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Path $OutputPath -Parent
if (-not (Test-Path -LiteralPath $outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$archive = [System.IO.Compression.ZipFile]::OpenRead($resolvedWorkbook)
try {
  $sharedStrings = [System.Collections.Generic.List[string]]::new()
  $sharedStringsText = Read-ZipEntryText -Archive $archive -EntryName 'xl/sharedStrings.xml'
  if ($sharedStringsText) {
    [xml]$sharedStringsXml = $sharedStringsText
    $sharedStringsManager = New-XmlNamespaceManager -Document $sharedStringsXml
    foreach ($item in @($sharedStringsXml.SelectNodes('//x:si', $sharedStringsManager))) {
      [void]$sharedStrings.Add((Get-RichText -Node $item -NamespaceManager $sharedStringsManager))
    }
  }

  [xml]$workbookXml = Read-ZipEntryText -Archive $archive -EntryName 'xl/workbook.xml'
  $workbookManager = New-XmlNamespaceManager -Document $workbookXml
  $workbookManager.AddNamespace('r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
  $sheetNode = @($workbookXml.SelectNodes('//x:sheets/x:sheet', $workbookManager) | Where-Object { $_.GetAttribute('name') -eq $SheetName })[0]
  if (-not $sheetNode) { throw "Worksheet not found: $SheetName" }

  [xml]$relationshipsXml = Read-ZipEntryText -Archive $archive -EntryName 'xl/_rels/workbook.xml.rels'
  $relationshipsManager = [System.Xml.XmlNamespaceManager]::new($relationshipsXml.NameTable)
  $relationshipsManager.AddNamespace('p', 'http://schemas.openxmlformats.org/package/2006/relationships')
  $relationshipId = $sheetNode.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
  $relationshipNode = $relationshipsXml.SelectSingleNode("//p:Relationship[@Id='$relationshipId']", $relationshipsManager)
  if (-not $relationshipNode) { throw "Worksheet relationship not found: $SheetName" }

  $target = $relationshipNode.GetAttribute('Target')
  $worksheetEntry = if ($target.StartsWith('/')) { $target.TrimStart('/') } else { "xl/$target" }
  [xml]$worksheetXml = Read-ZipEntryText -Archive $archive -EntryName $worksheetEntry
  if (-not $worksheetXml) { throw "Unable to read worksheet entry: $worksheetEntry" }
  $worksheetManager = New-XmlNamespaceManager -Document $worksheetXml

  $rows = @{}
  foreach ($rowNode in @($worksheetXml.SelectNodes('//x:sheetData/x:row', $worksheetManager))) {
    $cells = @{}
    foreach ($cellNode in @($rowNode.SelectNodes('./x:c', $worksheetManager))) {
      $columnIndex = Convert-ColumnReferenceToIndex -Reference $cellNode.GetAttribute('r')
      if ($columnIndex -lt 0) { continue }
      $cellType = $cellNode.GetAttribute('t')
      $valueNode = $cellNode.SelectSingleNode('./x:v', $worksheetManager)
      $inlineNode = $cellNode.SelectSingleNode('./x:is', $worksheetManager)
      $value = ''
      if ($cellType -eq 's' -and $valueNode) {
        $sharedIndex = [int]$valueNode.InnerText
        if ($sharedIndex -ge 0 -and $sharedIndex -lt $sharedStrings.Count) { $value = $sharedStrings[$sharedIndex] }
      } elseif ($cellType -eq 'inlineStr' -and $inlineNode) {
        $value = Get-RichText -Node $inlineNode -NamespaceManager $worksheetManager
      } elseif ($valueNode) {
        $value = $valueNode.InnerText
      }
      $cells[$columnIndex] = Normalize-Text $value
    }
    $rows[[int]$rowNode.GetAttribute('r')] = [pscustomobject]@{ Cells = $cells }
  }

  if (-not $rows.ContainsKey($HeaderRow)) { throw "Vehicle header row not found: $HeaderRow" }
  $vehicleColumns = [System.Collections.Generic.List[object]]::new()
  $vehicles = [System.Collections.Generic.List[object]]::new()
  foreach ($columnIndex in @($rows[$HeaderRow].Cells.Keys | Sort-Object)) {
    $headerValue = Get-CellText -Cells $rows[$HeaderRow].Cells -ColumnIndex $columnIndex
    $vehicleMatch = [regex]::Match($headerValue, '(?i)\bIS4PR[-\u2013\u2014]?[A-Z0-9]+\b')
    if (-not $vehicleMatch.Success) { continue }
    $vehicleCode = $vehicleMatch.Value.ToUpperInvariant() -replace '[\u2013\u2014]', '-'
    $vinMatch = [regex]::Match($headerValue.ToUpperInvariant(), '\b[A-HJ-NPR-Z0-9]{17}\b')
    $vehicle = [pscustomobject]@{
      vehicleCode = $vehicleCode
      vin = if ($vinMatch.Success) { $vinMatch.Value } else { $null }
      sourceHeader = $headerValue
    }
    $vehicles.Add($vehicle)
    $vehicleColumns.Add([pscustomobject]@{
      columnIndex = $columnIndex
      sourceColumn = Convert-ColumnIndexToLetters -ColumnIndex $columnIndex
      vehicle = $vehicle
    })
  }
  if ($vehicleColumns.Count -eq 0) { throw "No IS4PR vehicle headers found in row $HeaderRow." }

  $records = [System.Collections.Generic.List[object]]::new()
  $seenKeys = [System.Collections.Generic.HashSet[string]]::new()
  $currentCategory = ''
  $currentComponent = ''
  $currentNote = ''
  foreach ($rowIndex in @($rows.Keys | Sort-Object)) {
    if ($rowIndex -le $HeaderRow) { continue }
    $cells = $rows[$rowIndex].Cells
    $categoryCell = Get-CellText -Cells $cells -ColumnIndex 2
    $descriptor = Get-CellText -Cells $cells -ColumnIndex 3
    $rowNote = Get-CellText -Cells $cells -ColumnIndex 4
    $versionField = Get-CellText -Cells $cells -ColumnIndex 5
    if ($categoryCell) { $currentCategory = $categoryCell }
    if (-not $descriptor -and -not $versionField) { continue }

    $componentName = ''
    $componentCategory = $currentCategory
    $versionLabel = ''
    $effectiveNote = $rowNote
    if ($descriptor) {
      $isControllerName = $versionField -and $descriptor -match '^[A-Za-z0-9_-]{2,20}$'
      if ($isControllerName) {
        $componentName = $descriptor
        $versionLabel = $versionField
      } elseif ($versionField) {
        $componentName = if ($currentCategory) { "$currentCategory / $descriptor" } else { $descriptor }
        $versionLabel = $versionField
      } else {
        $componentName = if ($currentCategory) { $currentCategory } else { $descriptor }
        $versionLabel = $descriptor
      }
      $currentComponent = $componentName
      $currentNote = $rowNote
    } elseif ($currentComponent -and $versionField) {
      $componentName = $currentComponent
      $versionLabel = $versionField
      if (-not $effectiveNote) { $effectiveNote = $currentNote }
    }
    if (-not $componentName -or -not $versionLabel) { continue }

    foreach ($vehicleColumn in $vehicleColumns) {
      $versionValue = Get-CellText -Cells $cells -ColumnIndex $vehicleColumn.columnIndex
      if (-not $versionValue) { continue }
      $recordKey = "$($vehicleColumn.vehicle.vehicleCode)`0$componentName`0$versionLabel"
      if (-not $seenKeys.Add($recordKey)) { continue }
      $records.Add([pscustomobject]@{
        vehicleCode = $vehicleColumn.vehicle.vehicleCode
        componentName = $componentName
        componentCategory = if ($componentCategory) { $componentCategory } else { $null }
        versionLabel = $versionLabel
        versionValue = $versionValue
        note = if ($effectiveNote) { $effectiveNote } else { $null }
        sourceRow = $rowIndex
        sourceColumn = $vehicleColumn.sourceColumn
      })
    }
  }

  $output = [ordered]@{
    schemaVersion = 1
    sourceWorkbook = [System.IO.Path]::GetFileName($resolvedWorkbook)
    sourceSheet = $SheetName
    generatedAt = [DateTime]::UtcNow.ToString('o')
    vehicles = @($vehicles)
    records = @($records)
  }
  $json = $output | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($OutputPath, $json, [System.Text.UTF8Encoding]::new($false))
  Write-Output "Extracted $($vehicles.Count) vehicles and $($records.Count) component version records."
  Write-Output "Output: $OutputPath"
} finally {
  $archive.Dispose()
}
