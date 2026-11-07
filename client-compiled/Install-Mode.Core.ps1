<# .SYNOPSIS 安装模式的纯选择规则，无配置或任务副作用。 #>
function Resolve-InstallMode {
    <#
    .SYNOPSIS
    将入口选项转换为明确模式，空输入默认单轮。
    .PARAMETER Choice
    用户输入的空字符串、1或2。
    .OUTPUTS
    Single或Resident；其他输入抛出错误。
    #>
    param([AllowEmptyString()][string]$Choice)
    switch($Choice.Trim()) { '' {return 'Single'} '1' {return 'Single'} '2' {return 'Resident'} default {throw '请输入1或2；直接回车选择单轮模式。'} }
}
function Invoke-InstallModeFlow {
    <#
    .SYNOPSIS
    编排新设备准备与已有设备显式模式切换，不让默认选项暗中降级常驻。
    .PARAMETER Mode
    用户明确选择的目标模式。
    .PARAMETER Paired
    是否已有配对。
    .PARAMETER PreviousMode
    已配对任务的原模式。
    .PARAMETER WasEnabled
    已有任务是否启用。
    .PARAMETER Paused
    是否存在原暂停标记。
    .PARAMETER ConfirmSwitch
    切换前确认回调，返回布尔值。
    .PARAMETER Prepare
    仅新设备调用的配对及禁用任务准备回调。
    .PARAMETER Apply
    应用模式及可选启动的回调，参数为模式和是否允许启动。
    .OUTPUTS
    Applied或Cancelled，不将任务受理宣称为送达。
    #>
    param([ValidateSet('Single','Resident')][string]$Mode,[bool]$Paired,[string]$PreviousMode,[bool]$WasEnabled,[bool]$Paused,[scriptblock]$ConfirmSwitch,[scriptblock]$Prepare,[scriptblock]$Apply)
    if($Paired -and $PreviousMode -notin @('Single','Resident')){throw '已有设备任务归属或模式未知，停止安装。'}
    if($Paused -and $Mode -eq 'Single'){throw '设备处于常驻暂停状态；切换单轮会绕过暂停，已停止。请先人工核验并显式恢复。'}
    # 必须先确认再调用任何写入边界；直接回车默认单轮不能暗中降级既有常驻任务。
    if($Paired -and $PreviousMode -ne $Mode -and -not (& $ConfirmSwitch $PreviousMode $Mode)){return 'Cancelled'}
    if(-not $Paired){& $Prepare|Out-Host}
    $start=(-not $Paused) -and ((-not $Paired) -or $WasEnabled)
    & $Apply $Mode $start|Out-Host
    return 'Applied'
}
